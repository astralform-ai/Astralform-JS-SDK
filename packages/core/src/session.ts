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

// Retries for the client-tool result POST itself, independent of the SSE
// reconnect loop — reconnecting the *stream* can't recover a failed *result
// submission*, and retrying the POST avoids re-executing a client tool.
const TOOL_RESULT_MAX_RETRIES = 3;

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
  messages: Message[] = [];
  isStreaming = false;
  agentStatus: AgentStatus | null = null;
  agents: AgentInfo[] = [];
  skills: SkillInfo[] = [];
  enabledClientTools = new Set<string>();
  modelDisplayName: string | null = null;

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
      this.client.getConversations(),
      this.client.getAgents().catch(() => [] as AgentInfo[]),
      this.client.getSkills().catch(() => [] as SkillInfo[]),
    ]);

    if (status.status === "fulfilled") {
      this.agentStatus = status.value;
    }
    if (conversations.status === "fulfilled") {
      this.conversations = conversations.value;
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
      const stream = this.client.streamJobEvents(jobId, this.lastSeq, signal);
      // Client tools stay enabled across reconnects; re-seen tool requests are
      // deduped by submitted call_id in dispatchWireEvent, so a tool whose
      // result we never posted (drop before submit) still runs on resume.
      let sawTerminal: boolean;
      try {
        sawTerminal = await this.pumpStream(
          stream,
          conversationId,
          messageId,
          executeClientTools,
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
   */
  private async pumpStream(
    stream: AsyncGenerator<{ data: string }>,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
  ): Promise<boolean> {
    let sawTerminal = false;
    for await (const raw of stream) {
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
  ): void {
    this.conversationId = id;
    this.resetStreamingState();

    if (userMessageContent) {
      this.emit({ type: "user_message", content: userMessageContent });
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

  async deleteConversation(id: string): Promise<void> {
    try {
      await this.client.deleteConversation(id);
    } catch {
      // May already be deleted on backend
    }
    await this.storage.deleteConversation(id);
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
