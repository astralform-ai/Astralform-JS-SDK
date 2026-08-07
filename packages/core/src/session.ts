import { AstralformClient } from "./client.js";
import { InMemoryStorage, type ChatStorage } from "./storage.js";
import { ToolRegistry } from "./tools.js";
import { ProtocolRegistry } from "./protocol-registry.js";
import { translateWireEvent } from "./translate.js";
import type {
  AgentInfo,
  AstralformConfig,
  ChatEvent,
  ChatStreamRequest,
  Conversation,
  ConversationEvent,
  Message,
  AgentStatus,
  SendOptions,
  SkillInfo,
  ToolCallRequest,
  ToolResult,
  WireEvent,
} from "./types.js";
import { generateId } from "./utils.js";
import {
  AuthenticationError,
  ConnectionError,
  RateLimitError,
} from "./errors.js";

type ChatEventHandler = (event: ChatEvent) => void;

/**
 * Bounded auto-reconnect for a live SSE stream that drops mid-turn (worker
 * restart, network blip). We resume from ``lastSeq`` — the backend replays
 * missed events (``?after=seq``) and, for a job that already died, back-fills a
 * terminal event — so the UI recovers without a manual page refresh. Backoff is
 * exponential and capped; total window (~17s over 6 tries) comfortably covers a
 * server restart without spinning forever if the job is genuinely gone.
 */
const SSE_MAX_RECONNECTS = 6;

/**
 * Max silence tolerated on an established SSE stream before we declare it a
 * zombie and reconnect. The backend emits a keepalive every 15s
 * (``subscribe.py``), so a healthy stream never goes quiet this long. This
 * matters because some failures (notably HTTP/3 / QUIC connection deaths)
 * leave ``reader.read()`` pending forever — no bytes, no error, no FIN — and
 * without a watchdog the retry loop below never engages and the UI hangs on
 * "working" indefinitely. Set to 3x the keepalive interval.
 */
const SSE_STALL_TIMEOUT_MS = 45_000;

// Retries for the client-tool result POST itself, independent of the SSE
// reconnect loop — reconnecting the *stream* can't recover a failed *result
// submission*, and retrying the POST avoids re-executing a client tool.
const TOOL_RESULT_MAX_RETRIES = 3;

/**
 * Conversations fetched per page, by ``connect`` and ``loadMoreConversations``
 * alike. The two must use the same size: the offset is derived from how many
 * rows the server has returned so far, so a first page of a different size
 * would leave the second page's offset pointing at the wrong row.
 */
export const CONVERSATION_PAGE_SIZE = 50;

function sseReconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 5000);
}

function pathEquals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * ChatSession — translates the backend wire protocol into typed ChatEvents
 * for consumers. Owns HTTP + SSE plumbing, conversation state, and the
 * client-tool round-trip. Does NOT own block construction — consumers
 * build their own block state from the typed events.
 */
export class ChatSession {
  readonly client: AstralformClient;
  readonly toolRegistry: ToolRegistry;
  readonly storage: ChatStorage;
  /**
   * Pluggable UI protocol adapters. Consumers register a framework-
   * specific adapter (e.g. React) for each MIME type they can render,
   * typically gated on ``session.agentStatus.uiComponents.protocol``.
   * ``ToolBlock``-style consumers look up the adapter for an incoming
   * embedded resource and hand off rendering.
   */
  readonly protocols = new ProtocolRegistry();

  // State
  conversationId: string | null = null;
  conversations: Conversation[] = [];
  /**
   * Whether another page of conversations may exist on the server.
   *
   * Inferred from the last page being full, since the list endpoint returns a
   * bare array with no total. A total that happens to be an exact multiple of
   * the page size therefore costs one extra empty request before this flips —
   * cheaper than adding a count query to every list call.
   */
  hasMoreConversations = false;
  /** True while ``loadMoreConversations`` is in flight. */
  isLoadingConversations = false;
  messages: Message[] = [];
  isStreaming = false;
  agentStatus: AgentStatus | null = null;
  agents: AgentInfo[] = [];
  skills: SkillInfo[] = [];
  enabledClientTools = new Set<string>();
  modelDisplayName: string | null = null;

  /**
   * Ids of conversations the SERVER has handed us, which is the paging offset.
   *
   * Deliberately not ``conversations.length``. That array also holds
   * conversations created locally and unshifted on top (``createNewConversation``,
   * and the auto-created conversation in ``consumeJobStream``), so using its
   * length as the offset would over-count and silently skip a row of real
   * history on the next page. Tracking ids rather than a counter also makes
   * deletion self-correcting: removing a server-sourced conversation shifts
   * every later page up by one, and dropping its id from this set is exactly
   * that shift — while deleting a purely local one correctly changes nothing.
   */
  private serverConversationIds = new Set<string>();

  /**
   * Bumped every time ``connect()`` re-seeds the conversation list.
   *
   * A ``loadMoreConversations`` request issued before a re-seed describes the
   * OLD paging state, so applying its response afterwards both appends the
   * wrong rows and corrupts the offset. Concretely: with 100 rows held, an
   * offset-100 response landing after a reconnect has reset to rows 0-49 would
   * append rows 100-149 — a 50-row hole — and leave the id set at 100, so every
   * later page re-requests offset 100 and never advances again. The generation
   * is captured before the await and rechecked after, so a superseded response
   * is discarded instead.
   */
  private conversationsGeneration = 0;

  // Minimal in-session accumulation for the assistant message record.
  // Only top-level ``text`` blocks contribute; subagent / tool output
  // is tracked by the consumer's own block store.
  private accumulatedText = "";
  private currentTextPath: number[] | null = null;

  private handlers: Set<ChatEventHandler> = new Set();
  private abortController: AbortController | null = null;

  constructor(config: AstralformConfig, storage?: ChatStorage) {
    this.client = new AstralformClient(config);
    this.toolRegistry = new ToolRegistry();
    this.storage = storage ?? new InMemoryStorage();
  }

  on(handler: ChatEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: ChatEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors crash the session
      }
    }
  }

  async connect(): Promise<void> {
    const [status, conversations, agents, skills] = await Promise.allSettled([
      this.client.getAgentStatus(),
      this.client.getConversations(CONVERSATION_PAGE_SIZE),
      this.client.getAgents().catch(() => [] as AgentInfo[]),
      this.client.getSkills().catch(() => [] as SkillInfo[]),
    ]);

    if (status.status === "fulfilled") {
      this.agentStatus = status.value;
    }
    if (conversations.status === "fulfilled") {
      // Reconnect re-seeds page 1, so reset the paging state with it rather
      // than letting a previous connection's offset carry over. Bumping the
      // generation here (and only here — a FAILED fetch leaves the list intact,
      // so an in-flight page is still valid against it) invalidates any page
      // request already in flight against the old offset.
      this.conversationsGeneration++;
      this.conversations = conversations.value;
      this.serverConversationIds = new Set(
        conversations.value.map((c) => c.id),
      );
      this.hasMoreConversations =
        conversations.value.length === CONVERSATION_PAGE_SIZE;
    }
    if (agents.status === "fulfilled") {
      this.agents = agents.value;
    }
    if (skills.status === "fulfilled") {
      this.skills = skills.value;
    }

    this.emit({ type: "connected" });
  }

  async send(content: string, options?: SendOptions): Promise<void> {
    if ((options?.provider == null) !== (options?.model == null)) {
      throw new Error(
        "`provider` and `model` must be supplied together (client-side model selection).",
      );
    }
    if (this.isStreaming) return;

    const conversationId =
      options?.conversationId ?? this.conversationId ?? undefined;

    const userMessage: Message = {
      id: generateId(),
      conversationId: conversationId ?? "",
      role: "user",
      content,
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    if (conversationId) {
      await this.storage.addMessage(userMessage, conversationId);
    }
    this.messages.push(userMessage);

    const request: ChatStreamRequest = {
      message: content,
      conversation_id: conversationId,
      mcp_manifest: this.toolRegistry.getManifest(),
      enabled_mcp: Array.from(
        options?.enabledClientTools ?? this.enabledClientTools,
      ),
      upload_ids: options?.uploadIds,
      agent_name: options?.agentName,
      plan_mode: options?.planMode,
      image_mode: options?.imageMode,
      video_mode: options?.videoMode,
      goal: options?.goal,
      // Per-request model choice (client-side model selection).
      provider: options?.provider,
      model: options?.model,
      reasoning_effort: options?.reasoningEffort,
      temperature: options?.temperature,
    };

    await this.processStream(request);
  }

  async resendFromCheckpoint(
    messageId: string,
    newContent: string,
  ): Promise<void> {
    if (this.isStreaming) return;

    const request: ChatStreamRequest = {
      message: newContent,
      conversation_id: this.conversationId ?? undefined,
      resend_from: messageId,
      mcp_manifest: this.toolRegistry.getManifest(),
      enabled_mcp: Array.from(this.enabledClientTools),
    };

    await this.processStream(request);
  }

  private resetStreamingState(): void {
    this.accumulatedText = "";
    this.currentTextPath = null;
  }

  private async processStream(request: ChatStreamRequest): Promise<void> {
    this.isStreaming = true;
    this.resetStreamingState();
    this.abortController = new AbortController();

    try {
      await this.consumeJobStream(request);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        this.emit({
          type: "error",
          code: "connection_error",
          message: err instanceof Error ? err.message : String(err),
          blockPath: null,
        });
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
    }
  }

  /** Last received sequence number for resumable reconnection */
  private lastSeq = -1;

  /**
   * Client-tool call_ids whose result was already submitted this turn. On a
   * reconnect the resumed stream can replay a tool request we already handled;
   * this dedups so each is executed + submitted at most once (but a request we
   * never submitted still runs). Cleared at the start of each turn.
   */
  private submittedToolCallIds = new Set<string>();

  /** Current job ID for cancellation */
  currentJobId: string | null = null;

  private async consumeJobStream(request: ChatStreamRequest): Promise<void> {
    const job = await this.client.createJob(request);
    this.currentJobId = job.job_id;

    const conversationId = job.conversation_id;
    if (!this.conversationId) {
      this.conversationId = conversationId;
    }
    // Ensure the conversation exists in both the local array and
    // ChatStorage so title_generated, completeStream, and fallback
    // reload all work for backend-created conversations.
    if (!this.conversations.some((c) => c.id === conversationId)) {
      const now = new Date().toISOString();
      const conv = {
        id: conversationId,
        title: "",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.conversations.unshift(conv);
      await this.storage.createConversation(conversationId, "").catch(() => {});
    }
    // Backfill the just-sent user message if send() ran before we knew the
    // conversation id (first turn of an auto-created conversation).
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg?.role === "user" && !lastMsg.conversationId) {
      lastMsg.conversationId = conversationId;
      await this.storage.addMessage(lastMsg, conversationId).catch(() => {});
    }
    const messageId = job.message_id;
    this.lastSeq = -1;
    this.submittedToolCallIds.clear();

    await this.consumeEventStream(
      job.job_id,
      conversationId,
      messageId,
      true, // executeClientTools
    );
  }

  /**
   * Shared event consumption loop. Parses each wire event, updates
   * minimal session state, and emits typed ChatEvents to consumers.
   */
  private async consumeEventStream(
    jobId: string,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
  ): Promise<void> {
    // Capture the signal ONCE. detach()/disconnect() abort the controller and
    // then null it out synchronously, so re-reading this.abortController later
    // would lose the aborted state (?. → undefined → falsy) and the loop would
    // reconnect an unstoppable, signal-less stream. The AbortSignal stays valid
    // (and stays aborted) even after the controller is gone.
    const signal = this.abortController?.signal;

    for (let attempt = 0; ; attempt++) {
      // Each attempt gets its own controller, linked to the session signal,
      // so the stall watchdog can kill a zombie connection without aborting
      // the whole session — the retry below then resumes from lastSeq.
      const attemptController = new AbortController();
      const linkAbort = () => attemptController.abort();
      signal?.addEventListener("abort", linkAbort);
      // Client tools stay enabled across reconnects; re-seen tool requests are
      // deduped by submitted call_id in dispatchWireEvent, so a tool whose
      // result we never posted (drop before submit) still runs on resume.
      let sawTerminal: boolean;
      try {
        const stream = this.client.streamJobEvents(
          jobId,
          this.lastSeq,
          attemptController.signal,
        );
        sawTerminal = await this.pumpStream(
          stream,
          conversationId,
          messageId,
          executeClientTools,
          () => attemptController.abort(),
        );
      } catch (err) {
        if (signal?.aborted) return; // user cancelled / detached
        // Auth failures and rate limits can't be fixed by reconnecting (and
        // hammering a 429 is harmful) — surface them immediately. Genuine
        // connectivity failures (incl. a 5xx from a restarting server) retry.
        if (
          err instanceof AuthenticationError ||
          err instanceof RateLimitError
        ) {
          throw err;
        }
        if (attempt >= SSE_MAX_RECONNECTS) throw err;
        await this.sleepUnlessAborted(sseReconnectDelayMs(attempt + 1), signal);
        continue; // resume from lastSeq
      } finally {
        signal?.removeEventListener("abort", linkAbort);
      }

      // A terminal event (message_stop / error) ends the turn — including the
      // backend's back-filled terminal for a job that died mid-stream.
      if (sawTerminal || signal?.aborted) return;

      // Stream ended WITHOUT a terminal event: the worker/connection dropped
      // mid-turn. Resume from lastSeq so the backend can replay missed events
      // (and back-fill a terminal for a dead job) rather than leave the UI
      // hanging on "working".
      if (attempt >= SSE_MAX_RECONNECTS) {
        throw new ConnectionError("Lost connection to the response stream.");
      }
      await this.sleepUnlessAborted(sseReconnectDelayMs(attempt + 1), signal);
    }
  }

  /**
   * Consume a single SSE stream to exhaustion. Returns whether a terminal
   * event (``message_stop`` / ``error``) was seen, so the caller can decide
   * whether an ended stream means "turn done" vs "dropped, reconnect".
   *
   * ``onStall`` aborts the per-attempt connection: if no event arrives within
   * SSE_STALL_TIMEOUT_MS (backend keepalives land every 15s), the stream is a
   * zombie — ``reader.read()`` will never settle — so we kill the fetch and
   * throw a ConnectionError, feeding the caller's reconnect-from-lastSeq loop.
   */
  private async pumpStream(
    stream: AsyncGenerator<{ data: string }>,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
    onStall?: () => void,
  ): Promise<boolean> {
    let sawTerminal = false;
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = iterator.next();
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const stall = new Promise<never>((_, reject) => {
          stallTimer = setTimeout(() => {
            // Cancel the zombie fetch so the pending read rejects and the
            // connection is released instead of leaking one per reconnect.
            onStall?.();
            reject(
              new ConnectionError(
                `Stream stalled: no events for ${SSE_STALL_TIMEOUT_MS}ms`,
              ),
            );
          }, SSE_STALL_TIMEOUT_MS);
        });
        let result: IteratorResult<{ data: string }>;
        try {
          result = await Promise.race([next, stall]);
        } finally {
          clearTimeout(stallTimer);
        }
        if (result.done) break;
        const raw = result.value;
        let parsed: WireEvent;
        try {
          const data = JSON.parse(raw.data);
          if (
            typeof data !== "object" ||
            data === null ||
            typeof data.type !== "string"
          ) {
            // Legacy "done" sentinel — backend still emits it for subscribers.
            // Silently consume; the new protocol uses message_stop for turn end.
            if (typeof (data as { seq?: unknown })?.seq === "number") {
              this.lastSeq = (data as { seq: number }).seq;
            }
            continue;
          }
          parsed = data as WireEvent;
          if (typeof (data as Record<string, unknown>).seq === "number") {
            this.lastSeq = (data as Record<string, unknown>).seq as number;
          }
        } catch {
          continue;
        }

        if (parsed.type === "message_stop" || parsed.type === "error") {
          sawTerminal = true;
        }

        await this.dispatchWireEvent(
          parsed,
          conversationId,
          messageId,
          executeClientTools,
        );
      }
    } finally {
      // Fire-and-forget: on the stall path the pending read may never settle
      // (e.g. a custom fetchFn that ignores the abort signal), and awaiting
      // this would re-hang the pump the watchdog just rescued.
      void iterator.return?.(undefined).catch(() => {});
    }
    return sawTerminal;
  }

  /** Sleep for ``ms``, resolving early if the turn is aborted mid-backoff. */
  private sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** POST a client-tool result, retrying transient failures a few times. */
  private async submitToolResultWithRetry(
    payload: Parameters<AstralformClient["submitToolResult"]>[0],
  ): Promise<void> {
    const signal = this.abortController?.signal;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.submitToolResult(payload);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (
          err instanceof AuthenticationError ||
          err instanceof RateLimitError
        ) {
          throw err;
        }
        if (attempt >= TOOL_RESULT_MAX_RETRIES) throw err;
        await this.sleepUnlessAborted(sseReconnectDelayMs(attempt + 1), signal);
      }
    }
  }

  private async dispatchWireEvent(
    wire: WireEvent,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
  ): Promise<void> {
    // Side effects that depend on mutable session state must run before the
    // ChatEvent is emitted so consumers see a consistent view.
    this.applyWireSideEffects(wire, conversationId, messageId);

    const event = translateWireEvent(wire);
    if (event) {
      this.emit(event);
    }

    // Client tool round-trip — deferred to block_stop with
    // status=awaiting_client_result, where the parsed input is in final.input.
    if (
      executeClientTools &&
      wire.type === "block_stop" &&
      wire.status === "awaiting_client_result" &&
      wire.final?.call_id
    ) {
      const f = wire.final;
      const callId = (f.call_id as string) ?? "";
      // Dedup across reconnects: a resumed stream can replay a tool request we
      // already handled. Execute + submit each call_id at most once — but DO
      // run requests not yet submitted (e.g. the drop happened before we could
      // post the result), rather than skipping client tools wholesale.
      if (callId && !this.submittedToolCallIds.has(callId)) {
        const request: ToolCallRequest = {
          callId,
          toolName: (f.tool_name as string) ?? "",
          arguments: (f.input as Record<string, unknown>) ?? {},
          isClientTool: true,
        };
        const results = await this.executeClientTools([request]);
        // Retry the POST itself before giving up: reconnecting the SSE stream
        // can't recover a failed result submission, and retrying here avoids
        // re-executing the tool on a transient network blip.
        await this.submitToolResultWithRetry({
          conversation_id: conversationId,
          message_id: messageId,
          tool_results: results,
        });
        // Marked only after a successful submit, so a drop mid-POST re-runs it.
        this.submittedToolCallIds.add(callId);
      }
    }
  }

  /**
   * Synchronous replay of a single stored wire event — the side-effect +
   * translate + emit core of ``dispatchWireEvent`` without the (live-only)
   * client-tool round-trip. Called in a tight synchronous loop during history
   * restore so the consumer's per-event store writes batch into ONE render
   * instead of re-typing the whole conversation event by event.
   */
  private replayWireEvent(wire: WireEvent, conversationId: string): void {
    this.applyWireSideEffects(wire, conversationId, "");
    const event = translateWireEvent(wire);
    if (event) {
      this.emit(event);
    }
  }

  /**
   * State mutations driven by wire events. Kept separate from translation so
   * the pure wire → ChatEvent mapping can live in translate.ts and be reused
   * by the replay path.
   *
   * ``messageId`` is the server-assigned assistant message id for the current
   * turn; empty in the reconnect and conversation-switch replay paths where
   * messages have already been loaded from REST and shouldn't be re-pushed.
   */
  private applyWireSideEffects(
    wire: WireEvent,
    conversationId: string,
    messageId: string,
  ): void {
    switch (wire.type) {
      case "message_start":
        // Reset per-turn accumulator so multi-turn replay doesn't concatenate
        // text from prior turns into the next assistant message.
        this.resetStreamingState();
        if (wire.model) {
          this.modelDisplayName = wire.model;
        }
        return;

      case "block_start":
        // Track the currently open top-level text block so we can accumulate
        // its content for the assistant Message record.
        if (
          wire.kind === "text" &&
          (!wire.parent_path || wire.parent_path.length === 0)
        ) {
          this.currentTextPath = wire.path;
        }
        return;

      case "block_delta":
        if (
          wire.delta.channel === "text" &&
          this.currentTextPath !== null &&
          pathEquals(this.currentTextPath, wire.path)
        ) {
          this.accumulatedText += wire.delta.text;
        }
        return;

      case "block_stop":
        if (
          this.currentTextPath !== null &&
          pathEquals(this.currentTextPath, wire.path)
        ) {
          this.currentTextPath = null;
        }
        return;

      case "message_stop":
        // Only record the assistant message when we have the server's
        // message id. Reconnect/replay paths load messages via REST instead.
        if (messageId) {
          const assistantMessage: Message = {
            id: messageId,
            conversationId,
            role: "assistant",
            content: this.accumulatedText,
            status: "complete",
            createdAt: new Date().toISOString(),
          };
          this.messages.push(assistantMessage);
          this.storage
            .addMessage(assistantMessage, conversationId)
            .catch(() => {});
        }
        this.isStreaming = false;
        this.currentJobId = null;
        return;

      case "custom":
        if (wire.name === "title_generated") {
          const title = (wire.data.title as string) ?? "";
          if (this.conversationId && title) {
            const conv = this.conversations.find(
              (c) => c.id === this.conversationId,
            );
            if (conv) {
              conv.title = title;
            }
            this.storage
              .updateConversationTitle(this.conversationId, title)
              .catch(() => {});
          }
        }
        return;

      default:
        return;
    }
  }

  private async executeClientTools(
    toolCalls: ToolCallRequest[],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      const result = await this.toolRegistry.executeTool(call);
      results.push(result);
    }
    return results;
  }

  /**
   * Load conversation context (messages) without replaying events.
   * Used before reconnectToJob — SSE replay handles event replay.
   */
  async loadConversation(id: string): Promise<void> {
    this.conversationId = id;
    this.resetStreamingState();
    this.messages = await this.client
      .getMessages(id)
      .catch(() => this.storage.fetchMessages(id));
  }

  /**
   * Reconnect to a running job's SSE stream (e.g. after page reload).
   * Replays all events from the beginning and continues live.
   */
  async reconnectToJob(jobId: string): Promise<void> {
    if (this.isStreaming) return;

    this.isStreaming = true;
    this.currentJobId = jobId;
    this.lastSeq = -1;
    this.submittedToolCallIds.clear();
    this.resetStreamingState();
    this.abortController = new AbortController();

    try {
      await this.consumeEventStream(
        jobId,
        this.conversationId ?? "",
        "",
        false, // don't execute client tools on reconnect
      );
    } catch (err) {
      this.emit({
        type: "error",
        code: "connection_error",
        message: err instanceof Error ? err.message : String(err),
        blockPath: null,
      });
    } finally {
      this.isStreaming = false;
      this.abortController = null;
    }
  }

  /** Detach from the SSE stream without cancelling the job. */
  detach(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.isStreaming = false;
    this.resetStreamingState();
    this.emit({ type: "disconnected" });
  }

  /** Stop the job and disconnect (explicit user action). */
  disconnect(): void {
    if (this.currentJobId) {
      this.client.cancelJob(this.currentJobId).catch(() => {});
    }
    this.detach();
    this.currentJobId = null;
    // Drop all protocol adapters — lifecycle tied to the session.
    this.protocols.clear();
  }

  async createNewConversation(): Promise<string> {
    const id = generateId();
    const conversation = await this.storage.createConversation(
      id,
      "New Conversation",
    );
    this.conversations.unshift(conversation);
    this.conversationId = id;
    this.messages = [];
    return id;
  }

  /**
   * Replay one completed turn's already-fetched events, synchronously.
   *
   * Fetching is the caller's job (``StreamManager.restore`` loads every turn's
   * events in parallel and the message list once), so this is pure replay: no
   * awaits, so the whole restore runs in a single synchronous pass and the
   * consumer batches it into one render.
   *
   * ``userMessageContent`` is the prompt that triggered this turn. It's emitted
   * as a synthetic ``user_message`` BEFORE any of the turn's events: user
   * prompts aren't persisted in ``job_events``, and some events precede
   * ``message_start`` in the stream (e.g. ``memory_recall`` from prompt prep),
   * so leading with the prompt keeps the turn in order.
   */
  replayTurn(
    id: string,
    events: ConversationEvent[],
    userMessageContent?: string,
    userMessageId?: string,
    isSteer = false,
  ): void {
    this.conversationId = id;
    this.resetStreamingState();

    if (userMessageContent) {
      this.emit({
        type: "user_message",
        content: userMessageContent,
        ...(userMessageId ? { id: userMessageId } : {}),
        ...(isSteer ? { steer: true } : {}),
      });
    }

    // The data payload is authoritative for `type` (matching how
    // replay.ts#mapSseToChat reads it), with the SSE event name as a fallback
    // for pre-v2 rows.
    for (const ev of events) {
      const type = (ev.data.type as string) || ev.event;
      if (!type || type === "done") continue;

      const wire = { ...ev.data, type } as unknown as WireEvent;
      try {
        this.replayWireEvent(wire, id);
      } catch {
        // Skip malformed replay events
      }
    }
  }

  /**
   * Load a conversation's messages and replay its persisted history.
   *
   * Convenience for plain-``ChatSession`` consumers (the documented
   * conversation-management API). ``StreamManager`` drives restore itself —
   * loading messages once and replaying each turn in parallel — and does NOT
   * call this; it's kept so direct-Session usage doesn't break.
   *
   * Without ``jobId`` it replays the whole conversation; with one, just that
   * job's events.
   */
  async switchConversation(id: string, jobId?: string): Promise<void> {
    const [messagesResult, eventsResult] = await Promise.allSettled([
      this.client.getMessages(id).catch(() => this.storage.fetchMessages(id)),
      this.client.getConversationEvents(id, jobId),
    ]);
    this.messages =
      messagesResult.status === "fulfilled" ? messagesResult.value : [];
    this.replayTurn(
      id,
      eventsResult.status === "fulfilled" ? eventsResult.value : [],
    );
  }

  /**
   * Append the next page of conversation history to ``conversations``.
   *
   * The list is ordered ``updated_at DESC`` and paged by offset, so a
   * conversation bumped to the top mid-scroll can surface again in a later
   * page; ids already held are dropped rather than duplicated. Returns only
   * the conversations actually appended, which may be empty even on a full
   * page. Rejects on network failure with ``hasMoreConversations`` still true,
   * so the caller can retry.
   *
   * KNOWN LIMITATION — offset paging is only stable while the prefix already
   * consumed stays put. The offset tracking here corrects for perturbations
   * THIS session causes (local unshifts, ``deleteConversation``), but not for
   * ones it never sees:
   *
   * - a conversation this session hasn't loaded yet is bumped to the top (a
   *   headless routine or another device posting to it), pushing the whole
   *   list down — it lands inside the consumed prefix, which no later offset
   *   revisits;
   * - a conversation is deleted from another tab/device, shrinking the list so
   *   the next offset lands one row too far in.
   *
   * Each perturbation costs at most one conversation off the sidebar, and only
   * until the next ``connect()`` — that re-seeds page 1 and resets the paging
   * state, so a reload or reconnect always recovers it. Nothing is lost
   * server-side. Both cases are pinned by tests in
   * ``tests/conversation-paging.test.ts``.
   *
   * Closing the gap properly needs a stable server cursor (keyset paging on
   * ``(updated_at, id)``) rather than a raw offset, which is a backend change —
   * tracking ids client-side cannot discover a row that moved into a region
   * already scanned.
   */
  async loadMoreConversations(): Promise<Conversation[]> {
    // Scroll handlers fire far faster than the request completes; without this
    // guard every frame would refetch the same offset.
    if (this.isLoadingConversations || !this.hasMoreConversations) return [];
    this.isLoadingConversations = true;
    const generation = this.conversationsGeneration;
    try {
      const page = await this.client.getConversations(
        CONVERSATION_PAGE_SIZE,
        this.serverConversationIds.size,
      );
      // A reconnect re-seeded the list while this was in flight, so this page
      // describes a paging state that no longer exists. Drop it untouched —
      // connect() has already set conversations/hasMore for the new state, and
      // the caller's next call pages from there.
      if (generation !== this.conversationsGeneration) return [];
      this.hasMoreConversations = page.length === CONVERSATION_PAGE_SIZE;
      const fresh = page.filter((c) => !this.serverConversationIds.has(c.id));
      for (const c of page) this.serverConversationIds.add(c.id);
      // A locally-created conversation can already sit in the array from its
      // unshift; count it toward the offset (the server did return it) but
      // don't append a second copy.
      const known = new Set(this.conversations.map((c) => c.id));
      const appended = fresh.filter((c) => !known.has(c.id));
      this.conversations.push(...appended);
      return appended;
    } finally {
      this.isLoadingConversations = false;
    }
  }

  /**
   * Rename a conversation, server first.
   *
   * Deliberately NOT optimistic, unlike the delete below. A failed delete is
   * self-correcting (the row is still there on the next page fetch), but a
   * failed rename that had already been written locally would leave the
   * sidebar showing a title the server never accepted — and nothing refetches
   * a conversation that is already in the loaded list.
   *
   * Mirrors the `title_generated` path: the entry in `conversations` is
   * mutated in place, which is what every consumer of the list reads.
   */
  async renameConversation(id: string, title: string): Promise<void> {
    const updated = await this.client.renameConversation(id, title);
    const conv = this.conversations.find((c) => c.id === id);
    if (conv) {
      // The server's title, not the caller's — it trims before storing.
      conv.title = updated.title;
    }
    await this.storage.updateConversationTitle(id, updated.title);
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      await this.client.deleteConversation(id);
    } catch {
      // May already be deleted on backend
    }
    await this.storage.deleteConversation(id);
    // Shrinks the paging offset iff the server had handed us this one — every
    // later page now shifts up by one, and without this the next page would
    // skip a conversation. A purely local conversation isn't in the set, so
    // deleting it correctly leaves the offset alone.
    //
    // ``Set.delete`` reports whether it was there, which is exactly the
    // "was this server-sourced?" test. When it was, any page ALREADY in flight
    // is now stale for the same reason as a reconnect: its offset was computed
    // pre-delete but the server evaluates the query post-delete, so it starts
    // one row late and would skip that row for good. The adjustment above fixes
    // future requests and cannot rescue an outstanding one — so invalidate it.
    if (this.serverConversationIds.delete(id)) {
      this.conversationsGeneration++;
    }
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.conversationId === id) {
      this.conversationId = null;
      this.messages = [];
    }
  }

  toggleClientTool(name: string): boolean {
    if (this.enabledClientTools.has(name)) {
      this.enabledClientTools.delete(name);
      return false;
    }
    this.enabledClientTools.add(name);
    return true;
  }
}
