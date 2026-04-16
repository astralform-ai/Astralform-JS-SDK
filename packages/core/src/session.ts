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
  Message,
  ProjectStatus,
  SendOptions,
  SkillInfo,
  ToolCallRequest,
  ToolResult,
  WireEvent,
} from "./types.js";
import { generateId } from "./utils.js";

type ChatEventHandler = (event: ChatEvent) => void;

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
   * typically gated on ``session.projectStatus.uiComponents.protocol``.
   * ``ToolBlock``-style consumers look up the adapter for an incoming
   * embedded resource and hand off rendering.
   */
  readonly protocols = new ProtocolRegistry();

  // State
  conversationId: string | null = null;
  conversations: Conversation[] = [];
  messages: Message[] = [];
  isStreaming = false;
  projectStatus: ProjectStatus | null = null;
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
      this.client.getProjectStatus(),
      this.client.getConversations(),
      this.client.getAgents().catch(() => [] as AgentInfo[]),
      this.client.getSkills().catch(() => [] as SkillInfo[]),
    ]);

    if (status.status === "fulfilled") {
      this.projectStatus = status.value;
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
      enable_search: options?.enableSearch,
      plan_mode: options?.planMode,
    };

    await this.processStream(request);
  }

  async resendFromCheckpoint(
    messageId: string,
    newContent: string,
    options?: { enableSearch?: boolean },
  ): Promise<void> {
    if (this.isStreaming) return;

    const request: ChatStreamRequest = {
      message: newContent,
      conversation_id: this.conversationId ?? undefined,
      resend_from: messageId,
      mcp_manifest: this.toolRegistry.getManifest(),
      enabled_mcp: Array.from(this.enabledClientTools),
      enable_search: options?.enableSearch,
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

    const stream = this.client.streamJobEvents(
      job.job_id,
      this.lastSeq,
      this.abortController?.signal,
    );

    await this.consumeEventStream(
      stream,
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
    stream: AsyncGenerator<{ data: string }>,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
  ): Promise<void> {
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

      await this.dispatchWireEvent(
        parsed,
        conversationId,
        messageId,
        executeClientTools,
      );
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
      const request: ToolCallRequest = {
        callId: (f.call_id as string) ?? "",
        toolName: (f.tool_name as string) ?? "",
        arguments: (f.input as Record<string, unknown>) ?? {},
        isClientTool: true,
      };
      const results = await this.executeClientTools([request]);
      await this.client.submitToolResult({
        conversation_id: conversationId,
        message_id: messageId,
        tool_results: results,
      });
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
    this.resetStreamingState();
    this.abortController = new AbortController();

    try {
      const stream = this.client.streamJobEvents(
        jobId,
        this.lastSeq,
        this.abortController?.signal,
      );
      await this.consumeEventStream(
        stream,
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

  async switchConversation(
    id: string,
    jobId?: string,
    /**
     * User prompt that triggered this job, if known. Emitted as a
     * synthetic ``user_message`` ChatEvent right before the first
     * ``message_start`` of the replay. User messages aren't persisted
     * in ``job_events``, so without this the restored conversation
     * would show the agent response with no visible prompt above it.
     */
    userMessageContent?: string,
  ): Promise<void> {
    this.conversationId = id;
    this.resetStreamingState();

    const [messagesResult, eventsResult] = await Promise.allSettled([
      this.client.getMessages(id).catch(() => this.storage.fetchMessages(id)),
      this.client.getConversationEvents(id, jobId),
    ]);

    this.messages =
      messagesResult.status === "fulfilled" ? messagesResult.value : [];

    // Replay stored events via the same dispatch path. The consumer
    // rebuilds its block state from the replayed events. The data payload
    // is authoritative for `type` (matches how replay.ts#mapSseToChat reads
    // it) with the SSE event name as a fallback for pre-v2 rows.
    if (eventsResult.status === "fulfilled") {
      let userMessageEmitted = !userMessageContent;
      for (const ev of eventsResult.value) {
        const type = (ev.data.type as string) || ev.event;
        if (!type || type === "done") continue;

        // Inject the user prompt at the turn boundary — right before
        // the first ``message_start`` — so the consumer can insert a
        // user block above the agent response.
        if (!userMessageEmitted && type === "message_start") {
          this.emit({
            type: "user_message",
            content: userMessageContent!,
          });
          userMessageEmitted = true;
        }

        const wire = { ...ev.data, type } as unknown as WireEvent;
        try {
          await this.dispatchWireEvent(
            wire,
            id,
            "",
            false, // don't execute client tools on replay
          );
        } catch {
          // Skip malformed replay events
        }
      }
    }
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
