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
  display_name?: string;
  arguments: Record<string, unknown>;
  is_client_tool: boolean;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  call_id: string;
  tool: string;
}

export interface AgentStartEvent {
  type: "agent_start";
  agent_name: string;
  agent_display_name?: string;
  avatar_url?: string;
}

export interface AgentEndEvent {
  type: "agent_end";
  agent_name: string;
}

export interface SubagentStartEvent {
  type: "subagent_start";
  agent_name: string;
  display_name: string;
  tool_call_id: string;
  avatar_url?: string;
  description?: string;
}

export interface SubagentContentDeltaEvent {
  type: "subagent_content_delta";
  agent_name: string;
  tool_call_id: string;
  delta: {
    type: "text_delta";
    text: string;
  };
}

export interface SubagentUpdateEvent {
  type: "subagent_update";
  agent_name: string;
  display_name: string;
  tool_call_id: string;
}

export interface SubagentEndEvent {
  type: "subagent_end";
  agent_name: string;
  display_name: string;
  tool_call_id: string;
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  delta: {
    type: "thinking";
    text: string;
  };
}

export interface ThinkingCompleteEvent {
  type: "thinking_complete";
}

export interface SourcesEvent {
  type: "sources";
  sources: Array<{ title: string; url: string }>;
}

export interface CapsuleOutputEvent {
  type: "capsule_output";
  tool_name: string;
  agent_name: string;
  command?: string;
  output: string;
  duration_ms?: number;
}

export interface TodoUpdateEvent {
  type: "todo_update";
  todos: TodoItem[];
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
  | ToolUseEndEvent
  | AgentStartEvent
  | AgentEndEvent
  | SubagentStartEvent
  | SubagentContentDeltaEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  | SourcesEvent
  | CapsuleOutputEvent
  | TodoUpdateEvent
  | MessageStopEvent
  | SSEErrorEvent;

// --- High-Level Chat Events (SDK → consumer) ---

export type ChatEvent =
  | { type: "connected" }
  | { type: "chunk"; text: string }
  | { type: "tool_call"; request: ToolCallRequest }
  | { type: "tool_executing"; name: string }
  | { type: "tool_completed"; name: string; result: string }
  | { type: "tool_end"; callId: string; toolName: string }
  | {
      type: "agent_start";
      agentName: string;
      agentDisplayName?: string;
      avatarUrl?: string;
    }
  | { type: "agent_end"; agentName: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete" }
  | {
      type: "subagent_start";
      agentName: string;
      displayName: string;
      toolCallId: string;
      avatarUrl?: string;
      description?: string;
    }
  | {
      type: "subagent_chunk";
      agentName: string;
      toolCallId: string;
      text: string;
    }
  | {
      type: "subagent_update";
      agentName: string;
      displayName: string;
      toolCallId: string;
    }
  | {
      type: "subagent_end";
      agentName: string;
      displayName: string;
      toolCallId: string;
    }
  | { type: "sources"; sources: Array<{ title: string; url: string }> }
  | {
      type: "capsule_output";
      toolName: string;
      agentName: string;
      command?: string;
      output: string;
      durationMs?: number;
    }
  | {
      type: "todo_update";
      todos: TodoItem[];
    }
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
  isOrchestrator: boolean;
  isEnabled: boolean;
  avatarUrl?: string;
}

export interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  isEnabled: boolean;
}

// --- State Tracking Types ---

export interface SubagentState {
  agentName: string;
  displayName: string;
  avatarUrl?: string;
  description?: string;
  content: string;
  isActive: boolean;
}

export interface ToolState {
  toolName: string;
  displayName?: string;
  callId: string;
  status: "calling" | "executing" | "completed";
  isClientTool: boolean;
}

export interface CapsuleOutput {
  toolName: string;
  agentName: string;
  command?: string;
  output: string;
  durationMs?: number;
}

export interface Source {
  title: string;
  url: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  id?: string;
}

// --- Job Types ---

export interface JobCreateResponse {
  job_id: string;
  conversation_id: string;
  message_id: string;
  status: string;
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

export interface StreamJobSSEOptions {
  url: string;
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
