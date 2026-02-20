import { AstralformClient } from "./client.js";
import { AstralformError, ConnectionError } from "./errors.js";
import { InMemoryStorage, type ChatStorage } from "./storage.js";
import { ToolRegistry } from "./tools.js";
import type {
  AgentInfo,
  AstralformConfig,
  ChatEvent,
  ChatStreamRequest,
  Conversation,
  Message,
  PlatformTool,
  ProjectStatus,
  SendOptions,
  ServerMCPTool,
  SkillInfo,
  SSEEvent,
  ToolCallRequest,
  ToolResult,
} from "./types.js";
import { generateId } from "./utils.js";
import { WebMCPBridge } from "./web-mcp.js";

type ChatEventHandler = (event: ChatEvent) => void;

export class ChatSession {
  readonly client: AstralformClient;
  readonly toolRegistry: ToolRegistry;
  readonly webMCP: WebMCPBridge;
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
  platformTools: PlatformTool[] = [];
  mcpTools: ServerMCPTool[] = [];
  enabledTools = new Set<string>();
  enabledMcp = new Set<string>();
  modelDisplayName: string | null = null;

  private handlers: Set<ChatEventHandler> = new Set();
  private abortController: AbortController | null = null;

  constructor(config: AstralformConfig, storage?: ChatStorage) {
    this.client = new AstralformClient(config);
    this.toolRegistry = new ToolRegistry();
    this.webMCP = new WebMCPBridge(this.toolRegistry);
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
    const [status, conversations, tools, mcpTools, agents, skills] =
      await Promise.allSettled([
        this.client.getProjectStatus(),
        this.client.getConversations(),
        this.client.getTools(),
        this.client.getMcpTools(),
        this.client.getAgents().catch(() => [] as AgentInfo[]),
        this.client.getSkills().catch(() => [] as SkillInfo[]),
      ]);

    if (status.status === "fulfilled") {
      this.projectStatus = status.value;
    }
    if (conversations.status === "fulfilled") {
      this.conversations = conversations.value;
    }
    if (tools.status === "fulfilled") {
      this.platformTools = tools.value;
      for (const tool of this.platformTools) {
        this.enabledTools.add(tool.name);
      }
    }
    if (mcpTools.status === "fulfilled") {
      this.mcpTools = mcpTools.value;
      for (const tool of this.mcpTools) {
        this.enabledMcp.add(tool.name);
      }
    }
    if (agents.status === "fulfilled") {
      this.agents = agents.value;
    }
    if (skills.status === "fulfilled") {
      this.skills = skills.value;
    }

    if (this.webMCP.isAvailable()) {
      try {
        await this.webMCP.discover();
      } catch {
        // WebMCP discovery failed, continue without it
      }
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
      enabled_mcp: Array.from(options?.enabledMcp ?? this.enabledMcp),
      enabled_tools: Array.from(options?.enabledTools ?? this.enabledTools),
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
      enabled_mcp: Array.from(this.enabledMcp),
      enabled_tools: Array.from(this.enabledTools),
    };

    await this.processStream(request);
  }

  private async processStream(request: ChatStreamRequest): Promise<void> {
    this.isStreaming = true;
    this.streamingContent = "";
    this.abortController = new AbortController();

    try {
      await this.consumeStream(request, request.conversation_id ?? "");
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

  /** Maximum number of tool-use continuation rounds to prevent infinite loops */
  private static readonly MAX_TOOL_ROUNDS = 20;

  private async consumeStream(
    request: ChatStreamRequest,
    conversationId: string,
    toolRoundDepth = 0,
  ): Promise<void> {
    if (toolRoundDepth >= ChatSession.MAX_TOOL_ROUNDS) {
      this.emit({
        type: "error",
        error: new AstralformError(
          `Tool execution exceeded maximum of ${ChatSession.MAX_TOOL_ROUNDS} rounds`,
          "max_tool_rounds_exceeded",
        ),
      });
      return;
    }
    let messageId = "";
    let pendingClientToolCalls: ToolCallRequest[] = [];
    let stopTitle: string | undefined;

    const stream = this.client.chatStream(
      request,
      this.abortController?.signal,
    );

    for await (const raw of stream) {
      let parsed: SSEEvent;
      try {
        const data = JSON.parse(raw.data);
        // Validate that parsed data has a known event type
        if (
          typeof data !== "object" ||
          data === null ||
          typeof data.type !== "string"
        ) {
          continue;
        }
        parsed = data as SSEEvent;
      } catch {
        continue;
      }

      switch (parsed.type) {
        case "message_start":
          messageId = parsed.message_id;
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
            arguments: parsed.arguments,
            isClientTool: parsed.is_client_tool,
          };
          this.emit({ type: "tool_call", request: toolCall });
          if (parsed.is_client_tool) {
            pendingClientToolCalls.push(toolCall);
          }
          break;
        }

        case "agent_start":
          this.emit({
            type: "agent_start",
            agentName: parsed.agent_name,
            agentDisplayName: parsed.agent_display_name,
          });
          break;

        case "agent_end":
          this.emit({ type: "agent_end", agentName: parsed.agent_name });
          break;

        case "message_stop":
          stopTitle = parsed.title;
          if (
            parsed.stop_reason === "tool_use" &&
            pendingClientToolCalls.length > 0
          ) {
            const results = await this.executeClientTools(
              pendingClientToolCalls,
            );
            await this.client.submitToolResult({
              conversation_id: conversationId,
              message_id: messageId,
              tool_results: results,
            });
            pendingClientToolCalls = [];

            const continueRequest: ChatStreamRequest = {
              conversation_id: conversationId,
              continue_from_message: messageId,
              mcp_manifest: this.toolRegistry.getManifest(),
              enabled_mcp: Array.from(this.enabledMcp),
              enabled_tools: Array.from(this.enabledTools),
            };
            await this.consumeStream(
              continueRequest,
              conversationId,
              toolRoundDepth + 1,
            );
            return;
          }
          break;

        case "error":
          this.emit({
            type: "error",
            error: new AstralformError(parsed.message, parsed.code),
          });
          break;
      }
    }

    await this.completeStream(conversationId, messageId, stopTitle);
  }

  private async executeClientTools(
    toolCalls: ToolCallRequest[],
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      this.executingTool = call.toolName;
      this.emit({ type: "tool_executing", name: call.toolName });
      const result = await this.toolRegistry.executeTool(call);
      results.push(result);
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

  toggleTool(name: string): boolean {
    if (this.enabledTools.has(name)) {
      this.enabledTools.delete(name);
      return false;
    }
    this.enabledTools.add(name);
    return true;
  }

  toggleMcp(name: string): boolean {
    if (this.enabledMcp.has(name)) {
      this.enabledMcp.delete(name);
      return false;
    }
    this.enabledMcp.add(name);
    return true;
  }
}
