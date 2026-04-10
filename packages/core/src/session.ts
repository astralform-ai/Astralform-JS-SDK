import { AstralformClient } from "./client.js";
import { AstralformError, ConnectionError } from "./errors.js";
import { createRateLimitErrorFromPayload } from "./rate-limit.js";
import { InMemoryStorage, type ChatStorage } from "./storage.js";
import { ToolRegistry } from "./tools.js";
import type {
  AgentInfo,
  AstralformConfig,
  BlockDeltaPayload,
  ChatEvent,
  ChatStreamRequest,
  Conversation,
  Message,
  ProjectStatus,
  SendOptions,
  SkillInfo,
  TodoItem,
  ToolCallRequest,
  ToolResult,
  WireBlockDeltaPayload,
  WireEvent,
} from "./types.js";
import { generateId } from "./utils.js";

type ChatEventHandler = (event: ChatEvent) => void;

const RATE_LIMIT_PATTERN = /rate\s*limit/i;

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
          error: err instanceof Error ? err : new ConnectionError(String(err)),
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
    switch (wire.type) {
      case "message_start": {
        // Reset per-turn accumulator so multi-turn replay doesn't
        // concatenate text from prior turns into the next complete event.
        this.resetStreamingState();
        if (wire.model) {
          this.modelDisplayName = wire.model;
        }
        this.emit({
          type: "message_start",
          turnId: wire.turn_id,
          model: wire.model,
          agentName: wire.agent_name,
          agentAvatarUrl: wire.agent_avatar_url,
        });
        return;
      }

      case "block_start": {
        // Track the currently open top-level text block so we can
        // accumulate its content for the assistant Message record.
        if (
          wire.kind === "text" &&
          (!wire.parent_path || wire.parent_path.length === 0)
        ) {
          this.currentTextPath = wire.path;
        }
        this.emit({
          type: "block_start",
          turnId: wire.turn_id,
          path: wire.path,
          parentPath: wire.parent_path ?? null,
          kind: wire.kind,
          metadata: wire.metadata,
        });

        // Client tool execution is deferred to block_stop with
        // status=awaiting_client_result, where the parsed input is
        // available in final.input.  See block_stop handler below.
        return;
      }

      case "block_delta": {
        const delta = translateDelta(wire.delta);
        // Accumulate text for the top-level assistant content record
        if (
          delta.channel === "text" &&
          this.currentTextPath !== null &&
          pathEquals(this.currentTextPath, wire.path)
        ) {
          this.accumulatedText += delta.text;
        }
        this.emit({
          type: "block_delta",
          turnId: wire.turn_id,
          path: wire.path,
          delta,
        });
        return;
      }

      case "block_stop": {
        if (
          this.currentTextPath !== null &&
          pathEquals(this.currentTextPath, wire.path)
        ) {
          this.currentTextPath = null;
        }
        this.emit({
          type: "block_stop",
          turnId: wire.turn_id,
          path: wire.path,
          status: wire.status,
          final: wire.final,
        });

        // Client tool execution: the backend emits a block_stop with
        // status=awaiting_client_result once the tool's input_json is
        // fully parsed. The parsed arguments are in final.input.
        if (
          executeClientTools &&
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
          this.emit({ type: "tool_call", request });
          const results = await this.executeClientTools([request]);
          await this.client.submitToolResult({
            conversation_id: conversationId,
            message_id: messageId,
            tool_results: results,
          });
        }
        return;
      }

      case "message_stop": {
        const usage = {
          inputTokens: wire.usage.input_tokens ?? 0,
          outputTokens: wire.usage.output_tokens ?? 0,
          cachedTokens: wire.usage.cached_tokens ?? 0,
        };
        this.emit({
          type: "message_stop",
          turnId: wire.turn_id,
          stopReason: wire.stop_reason,
          usage,
          ttfbMs: wire.ttfb_ms,
          totalMs: wire.total_ms,
          stallCount: wire.stall_count,
        });
        // Only persist the assistant message during live streaming —
        // during replay (executeClientTools=false), messages are already
        // loaded from the backend and completeStream would duplicate them.
        if (executeClientTools || this.isStreaming) {
          await this.completeStream(
            conversationId,
            messageId,
            wire.job_id,
            wire.total_ms,
            usage,
          );
        } else {
          this.emitComplete(
            conversationId,
            "",
            wire.job_id,
            wire.total_ms,
            usage,
          );
        }
        this.isStreaming = false;
        this.currentJobId = null;
        return;
      }

      case "stall": {
        this.emit({
          type: "stall",
          sinceLastEventMs: wire.since_last_event_ms,
          stallCount: wire.stall_count,
        });
        return;
      }

      case "retry": {
        this.emit({
          type: "retry",
          attempt: wire.attempt,
          reason: wire.reason,
          backoffMs: wire.backoff_ms,
        });
        return;
      }

      case "error": {
        const isRateLimit =
          wire.code === "rate_limit_exceeded" ||
          RATE_LIMIT_PATTERN.test(wire.message);
        if (isRateLimit) {
          this.emit({
            type: "error",
            error: createRateLimitErrorFromPayload(
              wire as unknown as Record<string, unknown>,
            ),
          });
          return;
        }
        this.emit({
          type: "error",
          error: new AstralformError(wire.message, wire.code),
        });
        return;
      }

      case "keepalive": {
        this.emit({
          type: "keepalive",
          sinceLastEventMs: wire.since_last_event_ms,
        });
        return;
      }

      case "custom": {
        this.handleCustomEvent(wire.name, wire.data);
        return;
      }
    }
  }

  private handleCustomEvent(name: string, data: Record<string, unknown>): void {
    switch (name) {
      case "user_message":
        this.emit({
          type: "user_message",
          content: (data.content as string) ?? "",
          createdAt: data.created_at as number | undefined,
        });
        return;
      case "title_generated": {
        const title = (data.title as string) ?? "";
        if (this.conversationId && title) {
          const conv = this.conversations.find(
            (c) => c.id === this.conversationId,
          );
          if (conv) {
            conv.title = title;
          }
          // Persist to ChatStorage so reloads don't lose the title
          this.storage
            .updateConversationTitle(this.conversationId, title)
            .catch(() => {});
        }
        this.emit({ type: "title_generated", title });
        return;
      }
      case "todo_update": {
        const todos = (data.todos as TodoItem[]) ?? [];
        this.emit({ type: "todo_update", todos });
        return;
      }
      case "context_update":
        this.emit({
          type: "context_update",
          context: (data.context as Record<string, unknown>) ?? {},
          phase: data.phase as string | undefined,
          updatedAt: data.updated_at as number | undefined,
        });
        return;
      default:
        this.emit({ type: "custom", name, data });
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

  private emitComplete(
    conversationId: string,
    messageId: string,
    jobId: string | undefined,
    totalMs: number,
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
  ): void {
    const convTitle = this.conversations.find(
      (c) => c.id === conversationId,
    )?.title;
    this.emit({
      type: "complete",
      content: this.accumulatedText,
      conversationId,
      messageId,
      title: convTitle || undefined,
      metrics: {
        total_ms: totalMs,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      },
      jobId,
      job_id: jobId, // deprecated alias for backward compat
    });
  }

  private async completeStream(
    conversationId: string,
    messageId: string,
    jobId: string | undefined,
    totalMs: number,
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
  ): Promise<void> {
    const assistantMessage: Message = {
      id: messageId || generateId(),
      conversationId,
      role: "assistant",
      content: this.accumulatedText,
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);
    await this.storage.addMessage(assistantMessage, conversationId);
    this.emitComplete(
      conversationId,
      assistantMessage.id,
      jobId,
      totalMs,
      usage,
    );
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
        error: err instanceof Error ? err : new ConnectionError(String(err)),
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

  async switchConversation(id: string, jobId?: string): Promise<void> {
    this.conversationId = id;
    this.resetStreamingState();

    const [messagesResult, eventsResult] = await Promise.allSettled([
      this.client.getMessages(id).catch(() => this.storage.fetchMessages(id)),
      this.client.getConversationEvents(id, jobId),
    ]);

    this.messages =
      messagesResult.status === "fulfilled" ? messagesResult.value : [];

    // Replay stored events via the same dispatch path. The consumer
    // rebuilds its block state from the replayed events.
    if (eventsResult.status === "fulfilled") {
      for (const ev of eventsResult.value) {
        const wire = { type: ev.event, ...ev.data } as unknown as WireEvent;
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

// =============================================================================
// Wire → ChatEvent delta translator
// =============================================================================

function translateDelta(wire: WireBlockDeltaPayload): BlockDeltaPayload {
  switch (wire.channel) {
    case "text":
      return { channel: "text", text: wire.text };
    case "thinking":
      return { channel: "thinking", text: wire.text };
    case "signature":
      return { channel: "signature", signature: wire.signature };
    case "input":
      return { channel: "input", partialJson: wire.partial_json };
    case "input_arg":
      return {
        channel: "inputArg",
        argName: wire.arg_name,
        text: wire.text,
      };
    case "output":
      return { channel: "output", stream: wire.stream, chunk: wire.chunk };
    case "status":
      return {
        channel: "status",
        status: wire.status,
        note: wire.note,
      };
  }
}
