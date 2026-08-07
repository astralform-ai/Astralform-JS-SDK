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
 * exponential and capped: the six sleeps sum to 17.5s (0.5+1+2+4+5+5), which
 * comfortably covers a server restart without spinning forever if the job is
 * genuinely gone.
 *
 * That 17.5s is the BACKOFF total, not the time to give up. An attempt that
 * fails fast costs ~nothing, but one that stalls burns SSE_STALL_TIMEOUT_MS
 * before it even registers as a failure — so with all 7 attempts stalling the
 * worst case is 7 * 45s + 17.5s ≈ 5.5 minutes. That is the intended trade: a
 * stalled stream is indistinguishable from a slow one until the watchdog
 * fires, and cutting it shorter risks killing healthy long-running turns.
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
 *
 * DEPENDS ON THE KEEPALIVE'S FRAMING, not just its interval. The backend
 * sends it as a typed wire event (``{"event": "keepalive", "data": ...}``), so
 * it reaches ``streamJobSSE``'s parser as a real ``data:`` line and resets the
 * timer below. An SSE-protocol comment (``: keepalive``) would be silently
 * swallowed by that parser — it only reacts to ``event:``/``data:`` — and this
 * watchdog would then fire on every healthy turn that thinks for 45s. If the
 * backend ever changes that framing, this constant has to change with it.
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
  /**
   * Which conversation ``messages`` currently holds.
   *
   * Distinct from ``conversationId``, and the distinction is the point:
   * ``loadConversation`` moves the POINTER synchronously and installs the LIST
   * an await later, so for the whole duration of every load the two disagree.
   * Anything pairing a message with a conversation — ``regenerate`` above all —
   * has to read this one, or it will pair the previous conversation's last
   * message with the new conversation's id.
   */
  messagesConversationId: string | null = null;
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

  /**
   * Bumped by every ``loadConversation`` call, so an out-of-order fetch can
   * tell it is no longer the newest one and drop its result. Separate from
   * ``conversationsGeneration``, which guards the conversation LIST.
   */
  private loadGeneration = 0;

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
    // Captured so a send that never reaches the wire can put the list back —
    // see the restore in the catch below.
    let relocatedFrom: { messages: Message[]; id: string | null } | null = null;

    // Sending to an explicit conversation makes it the session's — catch the
    // pointer up now rather than waiting for an in-flight `loadConversation`
    // to land. `onSessionEvent` tags every emitted event with this field, so
    // leaving it behind would file this send's own stream events under the
    // conversation the caller just addressed away from: the same mis-tagging
    // the restore guards close, re-entering through the send path.
    //
    // The `loadGeneration` bump is not optional bookkeeping. `loadConversation`
    // reads its token as "am I still the newest load", and relies on that
    // implying "the session still points where I left it". Moving the pointer
    // here without bumping breaks the second half: an in-flight load would pass
    // its guard and install its list under a conversation the send has since
    // relocated to — one conversation's messages under another's id, the exact
    // pairing that guard exists to prevent. A pointer move IS an event a load
    // in flight must lose to.
    if (conversationId) {
      // Only a MOVE invalidates a load in flight. Re-stating the conversation
      // the session is already on — the ordinary case, since the manager
      // passes the active id on every send — must leave a load for that same
      // conversation alone, or sending while its history is still arriving
      // would throw the history away.
      if (conversationId !== this.conversationId) {
        this.loadGeneration++;
        relocatedFrom = { messages: this.messages, id: this.messagesConversationId };
        // Drop the old conversation's list with the pointer. Leaving it behind
        // is the same one-conversation's-messages-under-another's-id pairing
        // the load guard exists to prevent — and here nothing re-fetches, so
        // for a direct `ChatSession` caller (this is a documented public
        // option) it would simply persist. Through `StreamManager` the
        // in-flight restore reinstalls the right list, which is why the
        // manager-level tests never saw it.
        this.messages = [];
        this.messagesConversationId = conversationId;
      }
      this.conversationId = conversationId;
    }

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

    // `processStream` never rejects — it catches and emits an `error` event —
    // so a thrown-exception guard here would be dead code. A new job id is the
    // real signal that the send reached the wire: `consumeJobStream` assigns it
    // immediately after `createJob` returns.
    const jobIdBefore = this.currentJobId;
    await this.processStream(request);

    // The relocation above emptied the list before anything was sent. If no job
    // was created there is no new conversation's history to replace it and
    // nothing that will re-fetch, so a direct `ChatSession` caller would be
    // left holding nothing at all. Put it back.
    if (relocatedFrom && this.currentJobId === jobIdBefore) {
      this.messages = relocatedFrom.messages;
      this.messagesConversationId = relocatedFrom.id;
      this.conversationId = relocatedFrom.id;
    }
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
      // The list in hand is this conversation's — the backend just created it
      // around the turn being sent. Without this the pairing never becomes
      // valid and `regenerate` is a permanent no-op for a consumer that
      // reached a conversation this way.
      this.messagesConversationId = conversationId;
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
      // Bail BEFORE building the next attempt. An already-aborted signal never
      // dispatches `abort` again, so the listener below would silently miss it
      // and this attempt would go out after the caller disconnected — emitting
      // events, and potentially running a client tool, on a session it believes
      // is gone. Passing the outer signal straight to fetch used to make that
      // impossible (fetch checks `signal.aborted` up front); the per-attempt
      // controller removes that guarantee unless it is restored here.
      if (signal?.aborted) return;
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
            // Reject BEFORE aborting, and the order is load-bearing. Aborting
            // first makes the pending read reject too (StreamAbortedError from
            // `streaming.ts`), and whichever settles first wins the race below
            // — so a stall could surface as `stream_aborted`. Both retry
            // identically, but the diagnostic would then contradict this very
            // comment. Rejecting first settles the race deterministically;
            // `reject` changes state synchronously, so the later abort is a
            // no-op for the race.
            reject(
              new ConnectionError(
                `Stream stalled: no events for ${SSE_STALL_TIMEOUT_MS}ms`,
              ),
            );
            // Then cancel the zombie fetch so the connection is released
            // instead of leaking one per reconnect.
            onStall?.();
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
    // Claimed BEFORE the await, so the check below is "am I still the newest
    // load?" rather than "does the session still point where I left it?".
    const load = ++this.loadGeneration;
    this.conversationId = id;
    this.resetStreamingState();
    // Snapshot which messages already existed when the fetch was ISSUED. What
    // the server's reply cannot know about is exactly what arrived after that
    // instant — see the merge below.
    const knownBeforeFetch = new Set(this.messages.map((m) => m.id));
    const messages = await this.client
      .getMessages(id)
      .catch(() => this.storage.fetchMessages(id));
    // Nothing serializes callers, and this fetch is not instant. Install these
    // unconditionally and the session holds ONE conversation's id beside
    // ANOTHER's messages — the pair `send` (which posts to `conversationId`)
    // and `regenerate` (which resends `messages`' last user turn) read
    // together.
    //
    // A monotonic token rather than `this.conversationId !== id`, because that
    // comparison is ABA-blind: on A -> B -> A with A's FIRST fetch slow, the id
    // is back to A by the time that fetch lands, so the check passes and it
    // clobbers the fresh messages the second A load already installed. The id
    // says where the session is, not which load last spoke.
    if (load !== this.loadGeneration) return;
    // The fetch is a SNAPSHOT taken before it resolved, so a send that lands
    // while it is in flight is not in it. Assigning it straight over
    // `this.messages` drops that message with nothing to restore it — the SSE
    // handler only ever appends the assistant's reply, never the user turn
    // again — so the send is posted correctly and then vanishes from the list,
    // leaving `regenerate` with no last user message to resend.
    //
    // Keep only what was appended AFTER the fetch was issued, and only for this
    // conversation. Those two conditions are what make the server the source of
    // truth for everything else.
    //
    // Deliberately NOT "absent from the reply by id": a locally-created message
    // carries a client `generateId()` that is never sent to the server and never
    // reconciled with the row the server assigns, so an id comparison can never
    // match and would keep the local copy FOREVER. Revisiting the conversation
    // would then show the last sent message twice — once from the server,
    // correctly placed, once as a trailing duplicate carrying an id the server
    // has never heard of. `regenerate` takes the LAST user message, so it would
    // pick that duplicate and resend from a checkpoint id the server cannot
    // resolve. Arrival time answers the real question ("could the reply have
    // included this?"); identity cannot.
    //
    // Arrival time alone is necessary but NOT sufficient: a send that lands
    // while the fetch is open may still be committed before the read, in which
    // case the reply already carries it under the server's id and keeping the
    // local copy duplicates it. Whether it does is pure timing, so the second
    // condition compares the only fields both sides agree on — role and
    // content. Two identical prompts sent within one fetch window would
    // collapse to one; that is a far better failure than a phantom duplicate
    // carrying an id the server never assigned, which `regenerate` would then
    // pick as the last user message and `planRestore` would replay as a
    // free-standing steer bubble.
    const arrived = this.messages.filter(
      (m) => m.conversationId === id && !knownBeforeFetch.has(m.id),
    );
    // Compare against the TAIL only — the newest `arrived.length` rows. If the
    // server committed these sends they are necessarily the newest rows in the
    // reply, so nothing older can be a match. Comparing against the whole
    // history instead made any repeat of a prompt the conversation had EVER
    // contained collapse: "continue", "yes", "retry" are the norm in an agent
    // chat, and the just-sent copy would be dropped against a turn-3 row the
    // server's read never saw — the very loss this filter exists to prevent.
    const tail = messages.slice(Math.max(0, messages.length - arrived.length));
    const stillPending = arrived.filter(
      (m) => !tail.some((f) => f.role === m.role && f.content === m.content),
    );
    this.messages = stillPending.length
      ? [...messages, ...stillPending]
      : messages;
    this.messagesConversationId = id;
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
    // The empty list IS this conversation's list — say so, or every consumer
    // of the pairing (regenerate) stays blocked on the previous conversation.
    this.messagesConversationId = id;
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
    // Load the messages through `loadConversation` rather than fetching and
    // assigning them here. This function had its own copy of that assignment
    // and therefore its own copy of both bugs the guarded version fixes: no
    // generation token, so two overlapping calls install out of order; and an
    // unconditional overwrite, so a send landing mid-fetch is lost. One
    // implementation of the rule means it cannot drift back apart. Still
    // parallel — the two fetches start together, as before.
    // `loadConversation` claims its token synchronously, before its first
    // await, so reading `loadGeneration` straight after the call gives the
    // token THIS switch is operating under.
    const loading = this.loadConversation(id);
    const token = this.loadGeneration;
    const [loadResult, eventsResult] = await Promise.allSettled([
      loading,
      this.client.getConversationEvents(id, jobId),
    ]);
    // Guarding the messages alone was not enough — and left this in a worse
    // state than before. `replayTurn` opens by assigning `this.conversationId`
    // and then emits the whole turn, so a superseded call still did both of
    // the things this guard exists to stop: re-pointed the session at the
    // conversation the caller left, and poured its events out of the stream.
    // With the messages now correctly dropped, the id moved back alone —
    // leaving one conversation's messages under another's id, precisely the
    // pairing `loadConversation` documents itself as eliminating. Previously
    // both moved together: still wrong, but at least coherent.
    // Checked against the token, not against whether the load itself was
    // superseded: on a plain A -> B the load for A COMPLETES before B starts,
    // so it reports success, and only the events fetch is still open when B
    // supersedes. The token catches both — the load losing mid-flight, and
    // this whole call losing after it.
    if (token !== this.loadGeneration) return;
    // Ordered AFTER the token check, because a load can be both rejected AND
    // superseded: blanking then wipes the NEWER conversation's freshly
    // installed list and stamps it with this conversation's id — the same
    // mismatch this whole guard exists to prevent, arriving through the
    // failure path. A rejected load has already moved the pointer, so when
    // this call does still own the session the list must not be left behind.
    // Only reachable through a custom `ChatStorage` whose fallback throws
    // (`InMemoryStorage` never does), but `ChatStorage` is a public interface.
    if (loadResult.status === "rejected") {
      this.messages = [];
      this.messagesConversationId = id;
    }
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
      this.messagesConversationId = null;
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
