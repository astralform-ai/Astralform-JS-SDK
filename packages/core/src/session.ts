import { BlockBuilder } from "./block-builder.js";
import { AstralformClient } from "./client.js";
import { AstralformError, ConnectionError } from "./errors.js";
import { InMemoryStorage, type ChatStorage } from "./storage.js";
import { ToolRegistry } from "./tools.js";
import type {
  AgentInfo,
  AstralformConfig,
  CapsuleOutput,
  ChatEvent,
  ChatStreamRequest,
  Conversation,
  Message,
  ProjectStatus,
  SendOptions,
  SkillInfo,
  Source,
  SSEEvent,
  SubagentState,
  TodoItem,
  ToolCallRequest,
  ToolResult,
  ToolState,
} from "./types.js";
import { generateId } from "./utils.js";

type ChatEventHandler = (event: ChatEvent) => void;

export class ChatSession {
  readonly client: AstralformClient;
  readonly toolRegistry: ToolRegistry;
  readonly storage: ChatStorage;
  readonly blockBuilder: BlockBuilder;

  // State
  conversationId: string | null = null;
  conversations: Conversation[] = [];
  messages: Message[] = [];
  streamingContent = "";
  isStreaming = false;
  executingTool: string | null = null;
  projectStatus: ProjectStatus | null = null;
  agents: AgentInfo[] = [];
  skills: SkillInfo[] = [];
  enabledClientTools = new Set<string>();
  modelDisplayName: string | null = null;

  // New state fields
  thinkingContent = "";
  isThinking = false;
  activeSubagents = new Map<string, SubagentState>();
  sources: Source[] = [];
  capsuleOutputs: CapsuleOutput[] = [];
  todos: TodoItem[] = [];
  activeTools = new Map<string, ToolState>();

  private handlers: Set<ChatEventHandler> = new Set();
  private abortController: AbortController | null = null;

  constructor(
    config: AstralformConfig,
    storage?: ChatStorage,
    blockBuilder?: BlockBuilder,
  ) {
    this.client = new AstralformClient(config);
    this.toolRegistry = new ToolRegistry();
    this.storage = storage ?? new InMemoryStorage();
    this.blockBuilder = blockBuilder ?? new BlockBuilder();

    // Wire block builder to emit blocks_changed events
    this.blockBuilder.setOnChange(() => {
      this.emit({
        type: "blocks_changed",
        blocks: this.blockBuilder.getBlocks(),
      });
    });
  }

  on(handler: ChatEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: ChatEvent): void {
    // Feed the block builder first (produces blocks_changed events)
    if (event.type !== "blocks_changed" && event.type !== "connected") {
      this.blockBuilder.processEvent(event);
    }

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

    // Create user message
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

    // Build request
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
    this.streamingContent = "";
    this.thinkingContent = "";
    this.isThinking = false;
    this.activeSubagents.clear();
    this.sources = [];
    this.capsuleOutputs = [];
    this.todos = [];
    this.activeTools.clear();
  }

  private async processStream(request: ChatStreamRequest): Promise<void> {
    this.isStreaming = true;
    this.resetStreamingState();
    // Don't reset blockBuilder here — the client controls when to reset
    // (e.g. addUserBlock resets before adding the user block)
    this.abortController = new AbortController();

    try {
      await this.consumeJobStream(request);
    } catch (err) {
      this.emit({
        type: "error",
        error: err instanceof Error ? err : new ConnectionError(String(err)),
      });
    } finally {
      this.isStreaming = false;
      this.executingTool = null;
      this.abortController = null;
    }
  }

  /** Last received sequence number for resumable reconnection */
  private lastSeq = -1;

  /** Current job ID for cancellation */
  private currentJobId: string | null = null;

  private async consumeJobStream(request: ChatStreamRequest): Promise<void> {
    const job = await this.client.createJob(request);
    this.currentJobId = job.job_id;

    let conversationId = job.conversation_id;
    if (!this.conversationId) {
      this.conversationId = conversationId;
    }

    const messageId = job.message_id;
    this.lastSeq = -1;

    const stream = this.client.streamJobEvents(
      job.job_id,
      this.lastSeq,
      this.abortController?.signal,
    );

    // completeStream is called inside consumeEventStream when message_stop arrives
    // — no second call needed here
    await this.consumeEventStream(
      stream,
      conversationId,
      messageId,
      true, // executeClientTools
    );
  }

  /**
   * Shared event consumption loop used by both consumeJobStream and reconnectToJob.
   */
  private async consumeEventStream(
    stream: AsyncGenerator<{ data: string }>,
    conversationId: string,
    messageId: string,
    executeClientTools: boolean,
  ): Promise<void> {
    for await (const raw of stream) {
      let parsed: SSEEvent;
      try {
        const data = JSON.parse(raw.data);
        if (
          typeof data !== "object" ||
          data === null ||
          typeof data.type !== "string"
        ) {
          if (typeof data?.seq === "number") {
            this.lastSeq = data.seq;
          }
          continue;
        }
        parsed = data as SSEEvent;
        if (typeof (data as Record<string, unknown>).seq === "number") {
          this.lastSeq = (data as Record<string, unknown>).seq as number;
        }
      } catch {
        continue;
      }

      switch (parsed.type) {
        case "message_start":
          conversationId = parsed.conversation_id;
          if (!this.conversationId) {
            this.conversationId = conversationId;
          }
          if (parsed.message_id) {
            messageId = parsed.message_id;
          }
          if (parsed.model_display_name) {
            this.modelDisplayName = parsed.model_display_name;
            this.emit({
              type: "model_info",
              name: parsed.model_display_name,
            });
          }
          break;

        case "content_block_delta":
          this.streamingContent += parsed.delta.text;
          this.emit({ type: "chunk", text: parsed.delta.text });
          break;

        case "tool_use_start": {
          this.applyEvent(parsed);
          if (executeClientTools && parsed.is_client_tool) {
            const results = await this.executeClientTools([
              {
                callId: parsed.call_id,
                toolName: parsed.tool,
                displayName: parsed.display_name,
                description: parsed.description,
                arguments: parsed.arguments,
                isClientTool: parsed.is_client_tool,
                toolCategory: parsed.tool_category,
                iconUrl: parsed.icon_url,
              },
            ]);
            await this.client.submitToolResult({
              conversation_id: conversationId,
              message_id: messageId,
              tool_results: results,
            });
          }
          break;
        }

        case "subagent_content_delta": {
          const subagent = this.activeSubagents.get(parsed.tool_call_id);
          if (subagent) {
            subagent.content += parsed.delta.text;
          }
          this.emit({
            type: "subagent_chunk",
            agentName: parsed.agent_name,
            toolCallId: parsed.tool_call_id,
            text: parsed.delta.text,
          });
          break;
        }

        case "thinking_delta":
          this.thinkingContent += parsed.delta.text;
          this.isThinking = true;
          this.emit({ type: "thinking_delta", text: parsed.delta.text });
          break;

        case "thinking_complete":
          this.isThinking = false;
          this.emit({ type: "thinking_complete" });
          break;

        case "retry":
          this.emit({
            type: "retry",
            attempt: parsed.attempt,
            maxAttempts: parsed.max_attempts,
            delaySeconds: parsed.delay_seconds,
          });
          break;

        case "message_stop":
          // Emit complete IMMEDIATELY — don't wait for stream close
          // Post-processing continues in background but user is unlocked
          await this.completeStream(
            conversationId,
            messageId,
            parsed.title,
            parsed.metrics,
            parsed.job_id,
          );
          this.isStreaming = false;
          this.currentJobId = null;
          break;

        case "error":
          this.emit({
            type: "error",
            error: new AstralformError(parsed.message, parsed.code),
          });
          break;

        default:
          this.applyEvent(parsed);
      }
    }
  }

  /**
   * Apply a single SSE event to session state and notify consumers.
   * Shared between live streaming and historical event replay.
   */
  private applyEvent(event: SSEEvent): void {
    switch (event.type) {
      case "user_message":
        this.emit({ type: "user_message", content: event.content });
        break;

      case "title_generated":
        this.emit({ type: "title_generated", title: event.title });
        break;

      case "message_start":
        if (event.conversation_id && !this.conversationId) {
          this.conversationId = event.conversation_id;
        }
        if (event.model_display_name) {
          this.modelDisplayName = event.model_display_name;
          this.emit({ type: "model_info", name: event.model_display_name });
        }
        break;

      case "content_block_delta":
        this.streamingContent += event.delta.text;
        this.emit({ type: "chunk", text: event.delta.text });
        break;

      case "thinking_delta":
        this.thinkingContent += event.delta.text;
        this.isThinking = true;
        this.emit({ type: "thinking_delta", text: event.delta.text });
        break;

      case "thinking_complete":
        this.isThinking = false;
        this.emit({ type: "thinking_complete" });
        break;

      case "message_stop":
        this.emit({
          type: "complete",
          content: this.streamingContent,
          conversationId: this.conversationId ?? "",
          messageId: event.job_id ?? "",
          title: event.title,
          metrics: event.metrics,
          job_id: event.job_id,
        });
        break;

      case "tool_use_start": {
        const request: ToolCallRequest = {
          callId: event.call_id,
          toolName: event.tool,
          displayName: event.display_name,
          description: event.description,
          arguments: event.arguments,
          isClientTool: event.is_client_tool,
          toolCategory: event.tool_category,
          iconUrl: event.icon_url,
        };
        this.activeTools.set(event.call_id, {
          ...request,
          status: event.is_client_tool ? "calling" : "executing",
        });
        this.emit({ type: "tool_call", request });
        break;
      }

      case "tool_use_end": {
        const toolState = this.activeTools.get(event.call_id);
        if (toolState) {
          toolState.status = "completed";
        }
        this.emit({
          type: "tool_end",
          callId: event.call_id,
          toolName: event.tool,
          result: event.result,
          sources: event.sources,
          durationMs: event.duration_ms,
        });
        break;
      }

      case "agent_start":
        this.emit({
          type: "agent_start",
          agentName: event.agent_name,
          agentDisplayName: event.agent_display_name,
          avatarUrl: event.avatar_url,
        });
        break;

      case "agent_end":
        this.emit({ type: "agent_end", agentName: event.agent_name });
        break;

      case "subagent_start":
        this.activeSubagents.set(event.tool_call_id, {
          agentName: event.agent_name,
          displayName: event.display_name,
          avatarUrl: event.avatar_url,
          description: event.description,
          content: "",
          isActive: true,
        });
        this.emit({
          type: "subagent_start",
          agentName: event.agent_name,
          displayName: event.display_name,
          toolCallId: event.tool_call_id,
          avatarUrl: event.avatar_url,
          description: event.description,
        });
        break;

      case "subagent_update": {
        const sub = this.activeSubagents.get(event.tool_call_id);
        if (sub) {
          sub.agentName = event.agent_name;
          sub.displayName = event.display_name;
        }
        this.emit({
          type: "subagent_update",
          agentName: event.agent_name,
          displayName: event.display_name,
          toolCallId: event.tool_call_id,
        });
        break;
      }

      case "subagent_end": {
        const sub = this.activeSubagents.get(event.tool_call_id);
        if (sub) {
          sub.isActive = false;
        }
        this.emit({
          type: "subagent_end",
          agentName: event.agent_name,
          displayName: event.display_name,
          toolCallId: event.tool_call_id,
        });
        break;
      }

      case "subagent_tool_use":
        this.emit({
          type: "subagent_tool_use",
          agentName: event.agent_name,
          toolName: event.tool,
          toolCallId: event.tool_call_id,
          result: event.result,
        });
        break;

      case "sources":
        this.sources.push(...event.sources);
        this.emit({ type: "sources", sources: event.sources });
        break;

      case "capsule_output": {
        const capsule: CapsuleOutput = {
          toolName: event.tool_name,
          agentName: event.agent_name,
          command: event.command,
          output: event.output,
          durationMs: event.duration_ms,
          callId: event.call_id,
        };
        this.capsuleOutputs.push(capsule);
        this.emit({ type: "capsule_output", ...capsule });
        break;
      }

      case "capsule_output_chunk":
        this.emit({
          type: "capsule_output_chunk",
          callId: event.call_id,
          stream: event.stream,
          chunk: event.chunk,
        });
        break;

      case "todo_update":
        this.todos = event.todos;
        this.emit({ type: "todo_update", todos: event.todos });
        break;

      case "asset_created":
        this.emit({
          type: "asset_created",
          assetId: event.asset_id,
          name: event.name,
          url: event.url,
          mediaType: event.media_type,
          sizeBytes: event.size_bytes,
        });
        break;

      case "timeline_entry":
        this.emit({
          type: "timeline_entry",
          id: event.id,
          status: event.status,
          kind: event.kind,
          agent_name: event.agent_name,
          tool_name: event.tool_name,
          display_name: event.display_name,
          tool_category: event.tool_category,
          viewer: event.viewer,
          call_id: event.call_id,
          detail: event.detail,
          started_at: event.started_at,
          duration_ms: event.duration_ms,
          output_summary: event.output_summary,
          sources: event.sources,
          parent_id: event.parent_id,
          structured_output: event.structured_output,
        });
        break;

      case "editor_content_start":
        this.emit({
          type: "editor_content_start",
          callId: event.call_id,
          path: event.path,
          language: event.language,
        });
        break;

      case "editor_content_delta":
        this.emit({
          type: "editor_content_delta",
          callId: event.call_id,
          path: event.path,
          delta: event.delta,
        });
        break;

      case "editor_content_end":
        this.emit({
          type: "editor_content_end",
          callId: event.call_id,
        });
        break;
    }
  }

  private async executeClientTools(
    toolCalls: ToolCallRequest[],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      this.executingTool = call.toolName;
      const toolState = this.activeTools.get(call.callId);
      if (toolState) {
        toolState.status = "executing";
      }
      this.emit({ type: "tool_executing", name: call.toolName });
      const result = await this.toolRegistry.executeTool(call);
      results.push(result);
      if (toolState) {
        toolState.status = "completed";
      }
      this.emit({
        type: "tool_completed",
        name: call.toolName,
        result: result.result,
      });
    }
    this.executingTool = null;
    return results;
  }

  private async completeStream(
    conversationId: string,
    messageId: string,
    title?: string,
    metrics?: Record<string, unknown>,
    jobId?: string,
  ): Promise<void> {
    // Store assistant message
    const assistantMessage: Message = {
      id: messageId || generateId(),
      conversationId,
      role: "assistant",
      content: this.streamingContent,
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);
    await this.storage.addMessage(assistantMessage, conversationId);

    // Update conversation title if provided
    if (title && conversationId) {
      await this.storage.updateConversationTitle(conversationId, title);
      const conv = this.conversations.find((c) => c.id === conversationId);
      if (conv) {
        conv.title = title;
      }
    }

    this.emit({
      type: "complete",
      content: this.streamingContent,
      conversationId,
      messageId: assistantMessage.id,
      title,
      metrics,
      job_id: jobId,
    });
  }

  /**
   * Load conversation context (messages) without replaying events.
   * Used before reconnectToJob — SSE replay handles event replay.
   */
  async loadConversation(id: string): Promise<void> {
    this.conversationId = id;
    this.resetStreamingState();
    this.blockBuilder.reset();
    this.messages = await this.client
      .getMessages(id)
      .catch(() => this.storage.fetchMessages(id));
  }

  /**
   * Reconnect to a running job's SSE stream (e.g. after page reload).
   * Replays all events from the beginning and continues live.
   * Does NOT reset BlockBuilder — caller controls reset.
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

      // completeStream is called inside consumeEventStream on message_stop
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
      this.executingTool = null;
      this.abortController = null;
    }
  }

  disconnect(): void {
    // Cancel the running job if any
    if (this.currentJobId) {
      this.client.cancelJob(this.currentJobId).catch(() => {});
      this.currentJobId = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.isStreaming = false;
    this.streamingContent = "";
    this.executingTool = null;
    this.emit({ type: "disconnected" });
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
    this.streamingContent = "";
    return id;
  }

  async switchConversation(id: string, jobId?: string): Promise<void> {
    this.conversationId = id;
    this.resetStreamingState();
    this.blockBuilder.reset();

    const [messagesResult, eventsResult] = await Promise.allSettled([
      this.client.getMessages(id).catch(() => this.storage.fetchMessages(id)),
      this.client.getConversationEvents(id, jobId),
    ]);

    this.messages =
      messagesResult.status === "fulfilled" ? messagesResult.value : [];

    // Replay ALL stored events through the same handlers as live streaming
    if (eventsResult.status === "fulfilled") {
      for (const ev of eventsResult.value) {
        this.applyEvent({ type: ev.event, ...ev.data } as SSEEvent);
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
