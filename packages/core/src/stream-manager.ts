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

import type { ChatEvent } from "./types.js";
import { ChatEventType } from "./types.js";
import type { ChatSession } from "./session.js";

// =============================================================================
// Types
// =============================================================================

export type StreamState = "idle" | "streaming" | "restoring" | "detached";

export interface SendOptions {
  enableSearch?: boolean;
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
    if (this._state === "streaming") return;

    // Auto-create conversation if none active
    if (!this._activeConversationId) {
      const id = await this.session.createNewConversation();
      this.setActiveConversation(id);
    }

    this.setState("streaming");

    try {
      await this.session.send(content, {
        enableSearch: options?.enableSearch,
        agentName: options?.agentName,
        uploadIds: options?.uploadIds,
        planMode: options?.planMode,
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

  async switchTo(conversationId: string): Promise<void> {
    if (conversationId === this._activeConversationId) return;

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
      // Completed: load messages, replay version chain
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
        // triggered by the N-th user message. Feed the content into
        // ``switchConversation`` so it emits a ``user_message`` event
        // at the right boundary during replay.
        const userMessages = this.session.messages.filter(
          (m) => m.role === "user",
        );

        for (let i = 0; i < completedJobs.length; i++) {
          const job = completedJobs[i]!;
          const userContent = userMessages[i]?.content;
          await this.session.switchConversation(
            conversationId,
            job.job_id,
            userContent,
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
