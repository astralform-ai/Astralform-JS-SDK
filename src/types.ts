// --- Configuration ---

export interface AstralformConfig {
  apiKey: string;
  baseURL?: string;
  userId: string;
  fetch?: typeof globalThis.fetch;
}

// --- SSE Raw Events (from backend) ---

export interface MessageStartEvent {
  type: "message_start";
  message_id: string;
  conversation_id: string;
  model_display_name?: string;
  agent_name?: string;
  agent_display_name?: string;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta";
    text: string;
  };
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  index: number;
  call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  is_client_tool: boolean;
}

export interface AgentStartEvent {
  type: "agent_start";
  agent_name: string;
  agent_display_name?: string;
}

export interface AgentEndEvent {
  type: "agent_end";
  agent_name: string;
}

export interface MessageStopEvent {
  type: "message_stop";
  stop_reason: "end_turn" | "tool_use";
  title?: string;
}

export interface SSEErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export type SSEEvent =
  | MessageStartEvent
  | ContentBlockDeltaEvent
  | ToolUseStartEvent
  | AgentStartEvent
  | AgentEndEvent
  | MessageStopEvent
  | SSEErrorEvent;

// --- High-Level Chat Events (SDK → consumer) ---

export type ChatEvent =
  | { type: "connected" }
  | { type: "chunk"; text: string }
  | { type: "tool_call"; request: ToolCallRequest }
  | { type: "tool_executing"; name: string }
  | { type: "tool_completed"; name: string; result: string }
  | { type: "agent_start"; agentName: string; agentDisplayName?: string }
  | { type: "agent_end"; agentName: string }
  | {
      type: "complete";
      content: string;
      conversationId: string;
      messageId: string;
      title?: string;
    }
  | { type: "model_info"; name: string }
  | { type: "error"; error: Error }
  | { type: "disconnected" };

// --- Domain Models ---

export interface Conversation {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  parentId?: string;
  status: "sending" | "streaming" | "complete" | "error";
  createdAt: string;
  toolCalls?: ToolCallRequest[];
}

export interface ProjectStatus {
  isReady: boolean;
  llmConfigured: boolean;
  llmProvider?: string;
  llmModel?: string;
  message: string;
}

export interface PlatformTool {
  name: string;
  displayName: string;
  description: string;
  icon?: string;
}

export interface ServerMCPTool {
  name: string;
  description: string;
  serverName: string;
}

export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  isEnabled: boolean;
}

export interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  isEnabled: boolean;
}

// --- Request Types ---

export interface ChatStreamRequest {
  message?: string;
  conversation_id?: string;
  mcp_manifest?: ToolDefinition[];
  enabled_mcp?: string[];
  enabled_tools?: string[];
  continue_from_message?: string;
  resend_from?: string;
  agent_name?: string;
}

export interface ToolResultRequest {
  conversation_id: string;
  message_id: string;
  tool_results: ToolResult[];
}

export interface ToolResult {
  call_id: string;
  tool_name: string;
  result: string;
  is_error: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  isClientTool: boolean;
}

// --- WebMCP Types ---

export interface WebMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface WebMCPContext {
  tools: {
    list(): Promise<WebMCPTool[]>;
    call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: string }>;
    register(tool: WebMCPTool & { handler: WebMCPToolHandler }): void;
  };
}

export type WebMCPToolHandler = (
  args: Record<string, unknown>,
) => Promise<string>;

// --- SSE Stream Options ---

export interface StreamSSEOptions {
  url: string;
  body: ChatStreamRequest;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetchFn: typeof globalThis.fetch;
}

// --- Chat Stream Event (raw SSE parsed) ---

export interface ChatStreamEvent {
  event: string;
  data: string;
}

// --- Send Options ---

export interface SendOptions {
  conversationId?: string;
  enabledTools?: string[];
  enabledMcp?: string[];
  agentName?: string;
}

// --- Navigator augmentation for WebMCP ---

declare global {
  interface Navigator {
    modelContext?: WebMCPContext;
  }
}
