/**
 * StreamManager — high-level conversation lifecycle coordinator.
 *
 * Sits on top of ChatSession and manages the state machine for
 * multi-conversation SSE streaming. Framework-agnostic: emits
 * typed events to registered handlers. Block construction is NOT
 * the SDK's concern — consumers build their own block tree from
 * the forwarded ``ChatEvent`` instances.
 *
 *   import { ChatSession, StreamManager } from "@astralform/js";
 *   const session = new ChatSession({ ... });
 *   const manager = new StreamManager(session);
 *   manager.on((event) => {
 *     if (event.type === "event") {
 *       // event.event is a typed ChatEvent — dispatch to your reducer
 *     }
 *   });
 *   await manager.send("Hello");
 */

import type { ChatEvent, ModelChoiceOptions } from "./types.js";
import { ChatEventType } from "./types.js";
import type { ChatSession } from "./session.js";

// =============================================================================
// Types
// =============================================================================

export type StreamState = "idle" | "streaming" | "restoring" | "detached";

export interface SendOptions extends ModelChoiceOptions {
  agentName?: string;
  uploadIds?: string[];
  planMode?: boolean;
}

export type StreamManagerEvent =
  | { type: "stateChange"; state: StreamState; conversationId: string | null }
  | { type: "conversationChanged"; conversationId: string | null }
  | {
      type: "backgroundJobsChanged";
      jobs: ReadonlyMap<string, string>;
    }
  | { type: "event"; conversationId: string | null; event: ChatEvent }
  | { type: "versionsReady"; conversationId: string; count: number };

type EventHandler = (event: StreamManagerEvent) => void;

// =============================================================================
// StreamManager
// =============================================================================

export class StreamManager {
  private session: ChatSession;
  private _state: StreamState = "idle";
  private _activeConversationId: string | null = null;
  private _backgroundJobs = new Map<string, string>();
  private handlers: EventHandler[] = [];
  private unsub: (() => void) | null = null;

  constructor(session: ChatSession) {
    this.session = session;
    this.attach();
  }

  // ── Public state ──────────────────────────────────────────────

  get state(): StreamState {
    return this._state;
  }

  get activeConversationId(): string | null {
    return this._activeConversationId;
  }

  get backgroundJobs(): ReadonlyMap<string, string> {
    return this._backgroundJobs;
  }

  // ── Event subscription ────────────────────────────────────────

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(event: StreamManagerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors crash the manager
      }
    }
  }

  private setState(state: StreamState): void {
    this._state = state;
    this.emit({
      type: "stateChange",
      state,
      conversationId: this._activeConversationId,
    });
  }

  // ── Session event wiring ──────────────────────────────────────

  private attach(): void {
    this.unsub = this.session.on((event: ChatEvent) => {
      this.onSessionEvent(event);
    });
  }

  private onSessionEvent(event: ChatEvent): void {
    const convId = this.session.conversationId;

    // Forward every event to subscribers as a typed envelope
    this.emit({
      type: "event",
      conversationId: convId,
      event,
    });

    // Handle completion — message_stop is the terminal turn event.
    if (event.type === ChatEventType.MessageStop) {
      if (this._state === "streaming") {
        this.setState("idle");
      }
    }
  }

  // ── Send ──────────────────────────────────────────────────────

  async send(content: string, options?: SendOptions): Promise<void> {
    if ((options?.provider == null) !== (options?.model == null)) {
      throw new Error(
        "`provider` and `model` must be supplied together (client-side model selection).",
      );
    }
    if (this._state === "streaming") return;

    // Auto-create conversation if none active
    if (!this._activeConversationId) {
      const id = await this.session.createNewConversation();
      this.setActiveConversation(id);
    }

    this.setState("streaming");

    try {
      await this.session.send(content, {
        agentName: options?.agentName,
        uploadIds: options?.uploadIds,
        planMode: options?.planMode,
        provider: options?.provider,
        model: options?.model,
        reasoningEffort: options?.reasoningEffort,
        temperature: options?.temperature,
      });
    } catch {
      // AbortError from detach is expected
    }

    this.finalizeStream();
  }

  // ── Regenerate ────────────────────────────────────────────────

  async regenerate(): Promise<void> {
    if (this._state === "streaming") return;

    const userMsgs = this.session.messages.filter(
      (m: { role: string }) => m.role === "user",
    );
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    if (!lastUserMsg) return;

    this.setState("streaming");

    try {
      await this.session.resendFromCheckpoint(
        lastUserMsg.id,
        lastUserMsg.content,
      );
    } catch {
      // AbortError from detach is expected
    }

    this.finalizeStream();
  }

  // ── Switch conversation ───────────────────────────────────────

  /**
   * Switch the active conversation.
   *
   * ``opts.skipHistoryReplay`` is a fast path for consumers that CACHE a
   * restored conversation's rendered blocks: it moves the active pointer and
   * loads the message list (needed for send / regenerate context) but skips
   * the event fetch + replay entirely, and — critically — never enters the
   * ``restoring`` state, so a consumer that clears its block view on
   * ``restoring`` keeps showing the cached history with no flash of a spinner.
   * It is ignored when the target has a live background job (which must reconnect
   * to its stream), so passing it unconditionally is safe.
   */
  async switchTo(
    conversationId: string,
    opts?: { skipHistoryReplay?: boolean },
  ): Promise<void> {
    if (conversationId === this._activeConversationId) return;

    // Capture BEFORE the delete below: a live background job must reconnect,
    // so it can never take the cached fast path.
    const targetHadBackgroundJob = this._backgroundJobs.has(conversationId);

    // If streaming, detach (job keeps running in background)
    if (this._state === "streaming") {
      const oldConvId = this._activeConversationId;
      const jobId = this.session.currentJobId;
      if (oldConvId && jobId) {
        this._backgroundJobs.set(oldConvId, jobId);
        this.emit({
          type: "backgroundJobsChanged",
          jobs: this._backgroundJobs,
        });
      }
      this.session.detach();
    }

    // Clear background job for target (we're viewing it now)
    if (this._backgroundJobs.has(conversationId)) {
      this._backgroundJobs.delete(conversationId);
      this.emit({
        type: "backgroundJobsChanged",
        jobs: this._backgroundJobs,
      });
    }

    this.setActiveConversation(conversationId);

    if (opts?.skipHistoryReplay && !targetHadBackgroundJob) {
      // Cached: consumer already holds the rendered blocks. Load the message
      // list so send/regenerate have their context, but don't re-fetch or
      // replay the event history — and stay out of the ``restoring`` state.
      await this.session.loadConversation(conversationId);
      this.setState("idle");
      return;
    }

    await this.restore(conversationId);
  }

  // ── Create / delete conversation ──────────────────────────────

  async createConversation(): Promise<string> {
    const id = await this.session.createNewConversation();
    this.setActiveConversation(id);
    return id;
  }

  async deleteConversation(id: string): Promise<void> {
    await this.session.deleteConversation(id);
    this._backgroundJobs.delete(id);
    if (this._activeConversationId === id) {
      this._activeConversationId = null;
      this.emit({ type: "conversationChanged", conversationId: null });
    }
  }

  // ── Stop (explicit cancel) ────────────────────────────────────

  stop(): void {
    this.session.disconnect();
    this.setState("idle");
  }

  // ── Cleanup ───────────────────────────────────────────────────

  destroy(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.handlers = [];
  }

  // ── Internal: helpers ──────────────────────────────────────────

  private finalizeStream(): void {
    if (this._state === "streaming") {
      this.setState("idle");
    }
  }

  // ── Internal: restore ─────────────────────────────────────────

  private async restore(conversationId: string): Promise<void> {
    this.setState("restoring");

    // Check for active job
    let activeJobId: string | null = null;
    try {
      const res = await this.session.client.getActiveJob(conversationId);
      activeJobId = res.jobId;
    } catch {
      // Network error — assume no active job
    }

    if (activeJobId) {
      // Active job: load messages, reconnect to live SSE
      await this.session.loadConversation(conversationId);
      this.setState("streaming");
      try {
        await this.session.reconnectToJob(activeJobId);
      } catch {
        // Stream ended or aborted
      }
      if (this._state === "streaming") {
        this.setState("idle");
      }
    } else {
      // Completed: load the final messages once, then replay each turn.
      await this.session.loadConversation(conversationId);

      try {
        const jobs = await this.session.client.get<
          {
            job_id: string;
            status: string;
            metrics?: Record<string, unknown>;
          }[]
        >(`/v1/conversations/${encodeURIComponent(conversationId)}/jobs`);
        const completedJobs = jobs.filter(
          (j: { status: string }) => j.status === "completed",
        );

        // User prompts aren't persisted in job_events — they live in
        // the messages table. Pair each completed job with its user
        // prompt by chronological index: the N-th completed job was
        // triggered by the N-th user message.
        const userMessages = this.session.messages.filter(
          (m) => m.role === "user",
        );

        // Fetch every turn's events up front, in PARALLEL. The backend strips
        // live-only deltas from this path, so each response is small; parallel
        // fetch collapses N serial round-trips into one wave. We still fetch
        // per job (not the whole conversation in one call) so superseded
        // regeneration versions stay available for version navigation — the
        // whole-conversation endpoint drops them.
        const eventLists = await Promise.all(
          completedJobs.map((job: { job_id: string }) =>
            this.session.client
              .getConversationEvents(conversationId, job.job_id)
              .catch(() => []),
          ),
        );

        // Replay every turn in one SYNCHRONOUS pass (no awaits between events
        // or turns), so the consumer batches the whole history into a single
        // render instead of re-typing it event by event.
        for (let i = 0; i < completedJobs.length; i++) {
          this.session.replayTurn(
            conversationId,
            eventLists[i] ?? [],
            userMessages[i]?.content,
          );
        }

        if (completedJobs.length > 0) {
          this.emit({
            type: "versionsReady",
            conversationId,
            count: completedJobs.length,
          });
        }
      } catch {
        // Version chain loading failed — non-blocking
      }

      this.setState("idle");
    }
  }

  // ── Internal: set active conversation ─────────────────────────

  private setActiveConversation(id: string): void {
    this._activeConversationId = id;
    this.emit({ type: "conversationChanged", conversationId: id });
  }
}
