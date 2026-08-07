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
import { planRestore } from "./restore-plan";

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
  /**
   * Attach the image-generation tool to this turn. Per-message and off by
   * default — generating costs the developer real money at a third-party
   * provider. Gate the affordance on `AgentStatus.capabilities`.
   */
  imageMode?: boolean;
  /**
   * Attach the video-generation tool to this turn. Mutually exclusive with
   * `imageMode` at the composer level. See `SendOptions.videoMode` in types.ts
   * for the full rule — a clip animates an existing image, is silent, and holds
   * one shared GPU for minutes, so it is per-message and off by default.
   */
  videoMode?: boolean;
  /**
   * Start a durable long-horizon goal for this run (goal mode) — the text is the
   * goal objective the backend drives to completion. Omit for a normal turn.
   */
  goal?: string;
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
  /**
   * Bumped every time the active conversation moves. An async sequence that
   * captures it can then tell, at each await boundary, whether it is still the
   * one the user is waiting on — see ``restore``.
   */
  private generation = 0;

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
        imageMode: options?.imageMode,
        videoMode: options?.videoMode,
        goal: options?.goal,
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
   * the expensive event fetch + replay, and never enters the ``restoring``
   * state, so a consumer that clears its block view on ``restoring`` keeps
   * showing the cached history with no flash of a spinner.
   *
   * It still confirms there is no live job before skipping: the in-memory
   * background-job map is empty on a fresh instance (page reload) and blind to
   * jobs started in another tab/device, so the fast path always asks the server
   * (``getActiveJob``) and falls through to a full reconnect if one is running.
   * That one small request is the only cost it doesn't skip, so passing the
   * flag whenever you hold cached blocks is safe.
   */
  async switchTo(
    conversationId: string,
    opts?: { skipHistoryReplay?: boolean },
  ): Promise<void> {
    if (conversationId === this._activeConversationId) return;

    // Capture BEFORE the delete below: a background job THIS instance detached
    // must reconnect, so it can never take the cached fast path.
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
    // Captured AFTER the bump above, so this is this switch's own generation.
    const gen = this.generation;

    if (opts?.skipHistoryReplay && !targetHadBackgroundJob) {
      // Cached fast path — but a job started before this instance existed (page
      // reload) or in another tab/device won't be in _backgroundJobs, so confirm
      // with the server that nothing is live before skipping the reconnect.
      let activeJobId: string | null = null;
      try {
        activeJobId = (await this.session.client.getActiveJob(conversationId))
          .jobId;
      } catch {
        // Network error — treat as no active job (best-effort, matches restore()).
      }
      if (gen !== this.generation) return;
      if (!activeJobId) {
        // Consumer already holds the rendered blocks. Load the message list so
        // send/regenerate have their context, but skip the fetch + replay and
        // stay out of the ``restoring`` state.
        await this.session.loadConversation(conversationId);
        if (gen !== this.generation) return;
        this.setState("idle");
        return;
      }
      // A live job is running — fall through to a full restore(), which
      // reconnects to its stream.
    }

    await this.restore(conversationId, gen);
  }

  // ── Create / rename / delete conversation ─────────────────────

  async createConversation(): Promise<string> {
    const id = await this.session.createNewConversation();
    this.setActiveConversation(id);
    return id;
  }

  /**
   * Rename a conversation. Purely a relabel — no active-conversation or
   * background-job bookkeeping to do, unlike delete, so this is a passthrough.
   */
  async renameConversation(id: string, title: string): Promise<void> {
    await this.session.renameConversation(id, title);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.session.deleteConversation(id);
    this._backgroundJobs.delete(id);
    if (this._activeConversationId === id) {
      this.setActiveConversation(null);
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

  private async restore(conversationId: string, gen: number): Promise<void> {
    /**
     * Has the user moved on since this restore started?
     *
     * A restore is a long chain of awaits — the active-job probe, the message
     * list, the job list, then every completed turn's events in parallel. That
     * last one is seconds for a large conversation, and clicks are not
     * serialized, so a switch routinely lands mid-chain. Everything after this
     * point either mutates session state the newer switch now owns
     * (``loadConversation``, ``replayTurn``, ``reconnectToJob``) or announces a
     * state the newer switch is responsible for (``setState``), so a superseded
     * restore must stop rather than finish.
     *
     * Left to run, it re-pointed the session at the conversation it was
     * replaying and poured that conversation's whole history out of the event
     * stream, which the consumer rendered into the one on screen.
     *
     * Stopping is safe with a consumer that caches restored blocks: the blocks
     * for this conversation never arrive, so its cache stays empty and the next
     * open takes the full path again rather than the skip-replay fast path.
     */
    const superseded = (): boolean => gen !== this.generation;

    this.setState("restoring");

    // Check for active job
    let activeJobId: string | null = null;
    try {
      const res = await this.session.client.getActiveJob(conversationId);
      activeJobId = res.jobId;
    } catch {
      // Network error — assume no active job
    }
    if (superseded()) return;

    if (activeJobId) {
      // Active job: load messages, reconnect to live SSE
      await this.session.loadConversation(conversationId);
      if (superseded()) return;
      this.setState("streaming");
      try {
        await this.session.reconnectToJob(activeJobId);
      } catch {
        // Stream ended or aborted
      }
      // A switch during the stream already detached it and parked the job in
      // ``_backgroundJobs``; the newer switch owns the state from there.
      if (superseded()) return;
      if (this._state === "streaming") {
        this.setState("idle");
      }
    } else {
      // Completed: load the final messages once, then replay each turn.
      await this.session.loadConversation(conversationId);
      if (superseded()) return;

      try {
        const jobs = await this.session.client.get<
          {
            job_id: string;
            status: string;
            message_id?: string | null;
            metrics?: Record<string, unknown>;
          }[]
        >(`/v1/conversations/${encodeURIComponent(conversationId)}/jobs`);
        if (superseded()) return;
        const completedJobs = jobs.filter(
          (j: { status: string }) => j.status === "completed",
        );

        // User prompts aren't persisted in job_events — they live in the
        // messages table, so each turn has to be paired with the message that
        // started it. `job.message_id` is that link; planRestore also decides
        // where mid-run steers (user messages that start no job) and goal
        // continuations (jobs with no visible prompt) belong. See
        // restore-plan.ts for why pairing by index was wrong.
        const userMessages = this.session.messages.filter(
          (m) => m.role === "user",
        );
        const plan = planRestore({
          completedJobs: completedJobs.map((j) => ({
            job_id: j.job_id,
            message_id: j.message_id,
          })),
          userMessages: userMessages.map((m) => ({
            id: m.id,
            content: m.content,
          })),
        });

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
        // THE window. This wave is the slow part of a restore — the events of
        // every completed turn — and a click during it is the ordinary case,
        // not a rare one. The fetched events are discarded rather than
        // replayed: the replay below is what re-points the session and floods
        // the consumer.
        if (superseded()) return;

        const eventsByJobId = new Map(
          completedJobs.map((job, i) => [job.job_id, eventLists[i] ?? []]),
        );

        // Replay every step in one SYNCHRONOUS pass (no awaits between events
        // or turns), so the consumer batches the whole history into a single
        // render instead of re-typing it event by event. A steer replays as a
        // turn with no events: the bubble, and nothing after it.
        for (const step of plan) {
          if (step.kind === "steer") {
            this.session.replayTurn(
              conversationId,
              [],
              step.content,
              step.messageId,
              true,
            );
            continue;
          }
          this.session.replayTurn(
            conversationId,
            eventsByJobId.get(step.jobId) ?? [],
            step.content,
            step.messageId,
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

      // The replay is synchronous, so nothing can have superseded us between
      // it and here — but the `catch` above swallows a failure that may have
      // left the chain part-way, and this announcement belongs to whichever
      // switch is current.
      if (superseded()) return;
      this.setState("idle");
    }
  }

  // ── Internal: set active conversation ─────────────────────────

  private setActiveConversation(id: string | null): void {
    this._activeConversationId = id;
    // EVERY move of the pointer bumps the generation, not just `switchTo`:
    // creating a conversation and deleting the active one relocate the user
    // just as much, and an in-flight restore has to yield to those too.
    this.generation++;
    this.emit({ type: "conversationChanged", conversationId: id });
  }
}
