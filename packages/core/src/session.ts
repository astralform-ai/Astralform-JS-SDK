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

  private async processStream(request: ChatStreamRequest): Promise<void> {
    this.isStreaming = true;
    this.streamingContent = "";
    this.thinkingContent = "";
    this.isThinking = false;
    this.activeSubagents.clear();
    this.sources = [];
    this.capsuleOutputs = [];
    this.todos = [];
    this.activeTools.clear();
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
    // Step 1: Create job
    const job = await this.client.createJob(request);
    this.currentJobId = job.job_id;

    let conversationId = job.conversation_id;
    if (!this.conversationId) {
      this.conversationId = conversationId;
    }

    const messageId = job.message_id;
    this.lastSeq = -1;
    let stopTitle: string | undefined;

    // Step 2: Stream events
    const stream = this.client.streamJobEvents(
      job.job_id,
      this.lastSeq,
      this.abortController?.signal,
    );

    for await (const raw of stream) {
      let parsed: SSEEvent;
      try {
        const data = JSON.parse(raw.data);
        if (
          typeof data !== "object" ||
          data === null ||
          typeof data.type !== "string"
        ) {
          // Track seq even for non-typed events (e.g. ping)
          if (typeof data?.seq === "number") {
            this.lastSeq = data.seq;
          }
          continue;
        }
        parsed = data as SSEEvent;
        // Track seq from every event
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
          if (parsed.model_display_name) {
            this.modelDisplayName = parsed.model_display_name;
            this.emit({
              type: "model_info",
              name: parsed.model_display_name,
            });
          }
          if (parsed.agent_name) {
            this.emit({
              type: "agent_start",
              agentName: parsed.agent_name,
              agentDisplayName: parsed.agent_display_name,
            });
          }
          break;

        case "content_block_delta":
          this.streamingContent += parsed.delta.text;
          this.emit({ type: "chunk", text: parsed.delta.text });
          break;

        case "tool_use_start": {
          const toolCall: ToolCallRequest = {
            callId: parsed.call_id,
            toolName: parsed.tool,
            displayName: parsed.display_name,
            description: parsed.description,
            arguments: parsed.arguments,
            isClientTool: parsed.is_client_tool,
          };
          // Track in activeTools
          this.activeTools.set(parsed.call_id, {
            toolName: parsed.tool,
            displayName: parsed.display_name,
            description: parsed.description,
            arguments: parsed.arguments,
            callId: parsed.call_id,
            status: parsed.is_client_tool ? "calling" : "executing",
            isClientTool: parsed.is_client_tool,
          });
          this.emit({ type: "tool_call", request: toolCall });
          if (parsed.is_client_tool) {
            // Execute tool and submit result — job auto-resumes
            const results = await this.executeClientTools([toolCall]);
            await this.client.submitToolResult({
              conversation_id: conversationId,
              message_id: messageId,
              tool_results: results,
            });
          }
          break;
        }

        case "tool_use_end": {
          const toolState = this.activeTools.get(parsed.call_id);
          if (toolState) {
            toolState.status = "completed";
          }
          this.emit({
            type: "tool_end",
            callId: parsed.call_id,
            toolName: parsed.tool,
          });
          break;
        }

        case "agent_start":
          this.emit({
            type: "agent_start",
            agentName: parsed.agent_name,
            agentDisplayName: parsed.agent_display_name,
            avatarUrl: parsed.avatar_url,
          });
          break;

        case "agent_end":
          this.emit({ type: "agent_end", agentName: parsed.agent_name });
          break;

        case "subagent_start":
          this.activeSubagents.set(parsed.tool_call_id, {
            agentName: parsed.agent_name,
            displayName: parsed.display_name,
            avatarUrl: parsed.avatar_url,
            description: parsed.description,
            content: "",
            isActive: true,
          });
          this.emit({
            type: "subagent_start",
            agentName: parsed.agent_name,
            displayName: parsed.display_name,
            toolCallId: parsed.tool_call_id,
            avatarUrl: parsed.avatar_url,
            description: parsed.description,
          });
          break;

        case "subagent_update": {
          const sub = this.activeSubagents.get(parsed.tool_call_id);
          if (sub) {
            sub.agentName = parsed.agent_name;
            sub.displayName = parsed.display_name;
          }
          this.emit({
            type: "subagent_update",
            agentName: parsed.agent_name,
            displayName: parsed.display_name,
            toolCallId: parsed.tool_call_id,
          });
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

        case "subagent_end": {
          const sub = this.activeSubagents.get(parsed.tool_call_id);
          if (sub) {
            sub.isActive = false;
          }
          this.emit({
            type: "subagent_end",
            agentName: parsed.agent_name,
            displayName: parsed.display_name,
            toolCallId: parsed.tool_call_id,
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

        case "sources":
          this.sources.push(...parsed.sources);
          this.emit({ type: "sources", sources: parsed.sources });
          break;

        case "capsule_output": {
          const capsule: CapsuleOutput = {
            toolName: parsed.tool_name,
            agentName: parsed.agent_name,
            command: parsed.command,
            output: parsed.output,
            durationMs: parsed.duration_ms,
          };
          this.capsuleOutputs.push(capsule);
          this.emit({ type: "capsule_output", ...capsule });
          break;
        }

        case "todo_update":
          this.todos = parsed.todos;
          this.emit({ type: "todo_update", todos: parsed.todos });
          break;

        case "subagent_tool_use":
          this.emit({
            type: "subagent_tool_use",
            agentName: parsed.agent_name,
            toolName: parsed.tool,
            toolCallId: parsed.tool_call_id,
            result: parsed.result,
          });
          break;

        case "asset_created":
          this.emit({
            type: "asset_created",
            assetId: parsed.asset_id,
            name: parsed.name,
            url: parsed.url,
            mediaType: parsed.media_type,
            sizeBytes: parsed.size_bytes,
          });
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
          stopTitle = parsed.title;
          // No continuation needed — job handles tool result resumption
          break;

        case "error":
          this.emit({
            type: "error",
            error: new AstralformError(parsed.message, parsed.code),
          });
          break;
      }
    }

    this.currentJobId = null;
    await this.completeStream(conversationId, messageId, stopTitle);
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
    });
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

  async switchConversation(id: string): Promise<void> {
    this.conversationId = id;
    try {
      this.messages = await this.client.getMessages(id);
    } catch {
      this.messages = await this.storage.fetchMessages(id);
    }
    this.streamingContent = "";
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
