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

    // Auto-create conversation if none active.
    //
    // Deliberately NOT guarded the way `createConversation` is, and the
    // asymmetry is the point: that one is a navigation, so it loses to a
    // switch that lands in its await. This one is not — `send` must have a
    // target to send AT, and declining the pointer move would post the user's
    // composed text into whichever conversation they clicked meanwhile.
    // So `send` wins, and the two halves still agree: `session.send` relocates
    // to the same id a moment later. What it costs is that the bump can
    // supersede a `switchTo` that landed inside the await — recoverable,
    // unlike the sticky case, since the send's own `setState`/`finalizeStream`
    // announce and `_activeConversationId` is no longer that conversation, so
    // re-clicking it works.
    if (!this._activeConversationId) {
      const id = await this.session.createNewConversation();
      this.setActiveConversation(id);
    }

    this.setState("streaming");

    try {
      await this.session.send(content, {
        // Address the send explicitly. `ChatSession.send` otherwise falls back
        // to `session.conversationId`, which LAGS this pointer: a restore
        // assigns it synchronously but only reaches the next switch's own
        // `loadConversation` an await later, so between the two the session
        // still names the conversation the user left. The manager's pointer
        // moved the moment the user clicked; it is the authority.
        conversationId: this._activeConversationId ?? undefined,
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
    // Unlike `send`, regenerate cannot be addressed: `resendFromCheckpoint`
    // takes no conversation override, and the message id comes from
    // `session.messages` — which a settling switch can leave holding the
    // PREVIOUS conversation's list. Pairing that id with any conversation is
    // incoherent, so the only correct move is not to act.
    //
    // Gated on which conversation the MESSAGES belong to, not on the session's
    // conversation pointer. Pointer equality is wrong in the widest case
    // rather than an edge: `loadConversation`
    // assigns the pointer SYNCHRONOUSLY and installs the messages only when the
    // fetch returns, so for the whole duration of every ordinary load the two
    // pointers already agree while `messages` still holds the previous
    // conversation's turns. Regenerating there resends the OLD conversation's
    // last message under the NEW conversation's id.
    //
    // `messagesConversationId` moves with the list itself, so it answers the
    // question that actually matters — are these messages this conversation's?
    // Returns silently, as this method already does for a streaming state and
    // an empty history.
    if (this.session.messagesConversationId !== this._activeConversationId) {
      return;
    }

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
    this.detachStreamingTurn();

    // Clear background job for target (we're viewing it now)
    if (this._backgroundJobs.has(conversationId)) {
      this._backgroundJobs.delete(conversationId);
      this.emit({
        type: "backgroundJobsChanged",
        jobs: this._backgroundJobs,
      });
    }

    // Captured from the call itself, not read back afterwards — see
    // `setActiveConversation`.
    const gen = this.setActiveConversation(conversationId);

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
        this.settleIdle();
        return;
      }
      // A live job is running — fall through to a full restore(), which
      // reconnects to its stream.
    }

    await this.restore(conversationId, gen);
  }

  // ── Create / rename / delete conversation ─────────────────────

  async createConversation(): Promise<string> {
    // BEFORE `createNewConversation`, which is itself the relocation — it sets
    // `session.conversationId` and empties `session.messages`. `detach()`
    // emits `disconnected`, and `onSessionEvent` tags every event from
    // `session.conversationId`, so tearing down afterwards labels the OLD
    // conversation's teardown with the NEW conversation's id — and does it
    // before `conversationChanged` has fired. `switchTo` detaches while the
    // pointer is still the old one; this is the parity that comment claimed.
    this.detachStreamingTurn();
    // Read after `detachStreamingTurn`, which emits — a handler re-entering on
    // `backgroundJobsChanged` is inside the same window.
    const gen = this.generation;
    const id = await this.session.createNewConversation();
    // A `switchTo` landing inside that await claimed the newer generation, and
    // relocating over it would bump the generation out from under its restore:
    // the consumer sees `conversationChanged: B` followed by this one, and B
    // never restores. Last writer wins, everywhere.
    //
    // `createNewConversation` declines its own relocation under the same
    // condition, so the two halves agree. They have to: this check alone left
    // the manager on B with the session on the new id, which is worse than
    // either outcome because `switchTo` early-returns on B and the user cannot
    // click their way out of it.
    if (gen !== this.generation) return id;
    this.setActiveConversation(id);
    // Settle the state here. `setActiveConversation` bumps the generation, so
    // a restore this supersedes now returns WITHOUT emitting — including
    // without the `idle` that would have cleared a consumer's spinner. Unlike
    // `switchTo`, there is no successor restore to announce it instead, so
    // `_state` would sit at `restoring` on a brand-new empty conversation
    // until the next `send` or `stop` happened to clear it. Being a
    // generation-bumping origin means owning the announcement — but not over
    // a live turn: `createNewConversation` is awaited, and a send landing
    // inside that await owns the streaming state and will finalize it itself.
    this.settleIdle();
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
    // Evaluated up front, because the cancel below has to happen BEFORE the
    // delete: `session.deleteConversation` nulls `conversationId` and empties
    // `messages`, and `disconnect()` emits `disconnected`, which
    // `onSessionEvent` tags from that same field — so cancelling afterwards
    // labels the teardown `null`, before `conversationChanged` has fired. Same
    // ordering fault as `createConversation` had. It also stops the job a
    // round-trip sooner.
    const wasActive = this._activeConversationId === id;
    if (wasActive && this._state === "streaming") {
      this.session.disconnect();
      this._state = "idle"; // cancelled, not parked — recorded, not announced
    }
    await this.session.deleteConversation(id);
    // Re-tested, not `wasActive`: that was read before a real DELETE, and
    // relocating on it would overwrite a switch that landed during the
    // round-trip and bump the generation out from under its restore.
    // `wasActive` is still the right read for the CANCEL, which must happen
    // before the delete.
    if (this._activeConversationId === id) {
      // CANCEL rather than park. `detachStreamingTurn` is right when the user
      // navigates away — the turn keeps running and can be rejoined — but this
      // conversation is gone, so its output has nowhere to land. Parking it
      // would also re-add the very entry deleted below: consumers would render
      // a running-job indicator on a conversation no longer in the list, and
      // `switchTo` would compute `targetHadBackgroundJob` and force a full
      // restore of it.
      this.setActiveConversation(null);
      // Same reason as `createConversation`: this bumps the generation, so any
      // restore it supersedes goes quiet, and nothing else will announce.
      this.settleIdle();
    }
    // AFTER the branch above, so nothing can put the entry back.
    //
    // Emitted, or the consumer's last snapshot keeps a running-job badge on a
    // conversation no longer in the list — the same harm the `wasActive`
    // comment above argues against, on the branch that does not take that fix.
    // Not also cancelling server-side: neither branch does today, so adding it
    // to one would recreate the asymmetry this closes.
    if (this._backgroundJobs.delete(id)) {
      this.emit({ type: "backgroundJobsChanged", jobs: this._backgroundJobs });
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

  /**
   * Park a streaming turn as a background job and detach from its SSE stream.
   *
   * Every method that relocates the active conversation has to do this before
   * announcing a new state. Announcing `idle` while `session.isStreaming` is
   * still true is worse than announcing nothing: `manager.send` no longer bails
   * on the streaming state, calls `session.send`, and THAT bails on its own
   * `isStreaming` — so the message is never posted, no error is emitted, and
   * the composer looks ready the whole time.
   */
  private detachStreamingTurn(): void {
    if (this._state !== "streaming") return;
    const oldConvId = this._activeConversationId;
    const jobId = this.session.currentJobId;
    if (oldConvId && jobId) {
      this._backgroundJobs.set(oldConvId, jobId);
      this.emit({ type: "backgroundJobsChanged", jobs: this._backgroundJobs });
    }
    this.session.detach();
    // Record — without announcing — that the manager no longer owns a live
    // turn. The caller announces, and this is what lets it use `settleIdle()`:
    // a `streaming` state seen there afterwards belongs to a NEW send that
    // landed during the caller's own awaits, which owns its own announcement.
    this._state = "idle";
  }

  /**
   * Announce `idle` unless a turn is actually streaming.
   *
   * A `send` can land inside any of the switch paths — the fast path most
   * easily, since it deliberately stays out of `restoring` and so leaves the
   * composer live for the whole probe. `send` sets `streaming` and does not
   * bump the generation, so the path resumes, passes its supersession check,
   * and would announce a ready composer over a running stream. From there
   * `finalizeStream` and the `message_stop` branch both no-op (they only act
   * on `streaming`), so it stays `idle` for the whole turn — and the next send
   * reaches `session.send`, which bails on its own `isStreaming`: message
   * never posted, no error, composer ready throughout.
   */
  private settleIdle(): void {
    if (this._state === "streaming") return;
    this.setState("idle");
  }

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
      // Discriminated on the SESSION: `_state === "streaming"` is also what a
      // `send` landing during the probe sets, and `reconnectToJob` bails on
      // `isStreaming` without reconnecting anything — so announcing `idle` here
      // lands over a running turn (see `settleIdle` for why that is
      // unrecoverable). `settleIdle` itself does not fit; this branch sets
      // `streaming` itself, so its test cannot tell the two cases apart.
      if (this._state === "streaming" && !this.session.isStreaming) {
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
          // Checked per TURN, not just before the loop: "synchronous" bounds
          // out awaits, not re-entrancy. `replayTurn` emits through
          // `onSessionEvent` to every handler, and nothing in the `on()`
          // contract stops a handler driving the manager straight back —
          // `switchTo`, `createConversation` and `deleteConversation` all bump
          // the generation from inside this loop. Without this the remaining
          // turns keep pouring out, tagged with the abandoned conversation's
          // id, which is the leak this guard exists to close, reached through
          // the one door an await boundary does not cover.
          if (superseded()) return;
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

        // Before the announcement, not only before `setState` below. The
        // loop's check runs at the TOP of each turn, so a handler that
        // navigates away while the LAST turn replays — or the only turn, for a
        // single-job conversation — exits the loop normally with no iteration
        // left to catch it, and this would fire for the abandoned
        // conversation.
        if (superseded()) return;
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

      // The loop above can be superseded from inside a handler, and the `catch`
      // swallows a failure that may have left the chain part-way. Either way
      // this announcement belongs to whichever switch is current.
      if (superseded()) return;
      this.settleIdle();
    }
  }

  // ── Internal: set active conversation ─────────────────────────

  private setActiveConversation(id: string | null): number {
    this._activeConversationId = id;
    // The session's load token moves at the same instant as this one. Both
    // halves of a create then consult a counter that has actually changed —
    // otherwise `switchTo` bumps `generation` synchronously while
    // `loadGeneration` waits on the active-job probe, and for that whole
    // window the manager sees itself superseded and the session does not.
    this.session.invalidateLoadsInFlight();
    // EVERY move of the pointer bumps the generation, not just `switchTo`:
    // creating a conversation and deleting the active one relocate the user
    // just as much, and an in-flight restore has to yield to those too.
    const claimed = ++this.generation;
    // Returned so callers capture the generation THIS move claimed, before the
    // emit below. A handler reacting to `conversationChanged` by calling back
    // into the manager — routing on the conversation pointer is the obvious
    // consumer shape — bumps again synchronously, so a caller reading
    // `this.generation` afterwards would capture the INNER value and never see
    // itself as superseded. Both switches would then run to completion and the
    // abandoned one would replay its whole history: the same re-entrancy door
    // the replay loop already guards against.
    this.emit({ type: "conversationChanged", conversationId: id });
    return claimed;
  }
}
