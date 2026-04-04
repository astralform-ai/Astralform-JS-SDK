// --- Configuration ---

export interface AstralformConfig {
  apiKey: string;
  baseURL?: string;
  userId: string;
  fetch?: typeof globalThis.fetch;
}

// --- Event type constants ---

export const ChatEventType = {
  Connected: "connected",
  BlocksChanged: "blocks_changed",
  UserMessage: "user_message",
  TitleGenerated: "title_generated",
  ModelInfo: "model_info",
  Chunk: "chunk",
  ToolCall: "tool_call",
  ToolExecuting: "tool_executing",
  ToolProgress: "tool_progress",
  ToolCompleted: "tool_completed",
  ToolEnd: "tool_end",
  AgentStart: "agent_start",
  AgentEnd: "agent_end",
  ThinkingDelta: "thinking_delta",
  ThinkingComplete: "thinking_complete",
  SubagentStart: "subagent_start",
  SubagentChunk: "subagent_chunk",
  SubagentUpdate: "subagent_update",
  SubagentEnd: "subagent_end",
  SubagentToolUse: "subagent_tool_use",
  CapsuleOutput: "capsule_output",
  CapsuleOutputChunk: "capsule_output_chunk",
  AssetCreated: "asset_created",
  TodoUpdate: "todo_update",
  EditorContentStart: "editor_content_start",
  EditorContentDelta: "editor_content_delta",
  EditorContentEnd: "editor_content_end",
  Complete: "complete",
  Error: "error",
  Disconnected: "disconnected",
  Retry: "retry",
  ContextUpdate: "context_update",
  DesktopStream: "desktop_stream",
  AttachmentStaged: "attachment_staged",
  WorkspaceReady: "workspace_ready",
} as const;

// --- SSE Raw Events (from backend) ---

export interface UserMessageEvent {
  type: "user_message";
  content: string;
  created_at?: number;
}

export interface TitleGeneratedEvent {
  type: "title_generated";
  title: string;
}

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
  description?: string;
  arguments: Record<string, unknown>;
  is_client_tool: boolean;
  tool_category?: string;
  icon_url?: string;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  call_id: string;
  tool: string;
  result?: string;
  sources?: { title: string; url: string; snippet?: string }[];
  duration_ms?: number;
}

export interface ToolExecutingEvent {
  type: "tool_executing";
  call_id: string;
  tool: string;
}

export interface ToolProgressEvent {
  type: "tool_progress";
  call_id: string;
  tool: string;
  index: number;
  total: number;
  item: { title: string; url: string; snippet?: string };
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

export interface CapsuleOutputEvent {
  type: "capsule_output";
  tool_name: string;
  agent_name: string;
  command?: string;
  output: string;
  duration_ms?: number;
  call_id?: string;
}

export interface CapsuleOutputChunkEvent {
  type: "capsule_output_chunk";
  call_id: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface TodoUpdateEvent {
  type: "todo_update";
  todos: TodoItem[];
}

export interface MessageStopEvent {
  type: "message_stop";
  stop_reason: "end_turn" | "tool_use";
  title?: string;
  metrics?: Record<string, unknown>;
  job_id?: string;
}

export interface SSEErrorEvent {
  type: "error";
  code: string;
  message: string;
  retry_after?: number;
  retry_after_sec?: number;
  reset_at?: number | string;
  scope?: string;
  policy_id?: string;
  limit?: number;
  remaining?: number;
  request_id?: string;
}

export interface SubagentToolUseEvent {
  type: "subagent_tool_use";
  agent_name: string;
  tool: string;
  tool_call_id: string;
  result?: string;
}

export interface AssetCreatedEvent {
  type: "asset_created";
  asset_id: string;
  name: string;
  url: string;
  media_type: string;
  size_bytes: number;
}

export interface EditorContentStartEvent {
  type: "editor_content_start";
  call_id: string;
  path: string;
  language: string;
}

export interface EditorContentDeltaEvent {
  type: "editor_content_delta";
  call_id: string;
  path: string;
  delta: string;
}

export interface EditorContentEndEvent {
  type: "editor_content_end";
  call_id: string;
}

export interface RetryEvent {
  type: "retry";
  attempt: number;
  max_attempts: number;
  delay_seconds: number;
}

export interface ContextUpdateEvent {
  type: "context_update";
  context: Record<string, unknown>;
  phase?: string;
  updated_at?: number;
}

export interface DesktopStreamEvent {
  type: "desktop_stream";
  url: string;
  auth_key: string;
  sandbox_id: string;
}

export interface AttachmentStagedEvent {
  type: "attachment_staged";
  files: {
    name: string;
    path: string;
    media_type: string;
    size_bytes: number;
  }[];
}

export interface WorkspaceReadyEvent {
  type: "workspace_ready";
  conversation_id: string;
  sandbox_id: string;
}

export type SSEEvent =
  | MessageStartEvent
  | UserMessageEvent
  | TitleGeneratedEvent
  | ContentBlockDeltaEvent
  | ToolUseStartEvent
  | ToolUseEndEvent
  | ToolExecutingEvent
  | ToolProgressEvent
  | AgentStartEvent
  | AgentEndEvent
  | SubagentStartEvent
  | SubagentContentDeltaEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | SubagentToolUseEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  | CapsuleOutputEvent
  | CapsuleOutputChunkEvent
  | TodoUpdateEvent
  | MessageStopEvent
  | AssetCreatedEvent
  | EditorContentStartEvent
  | EditorContentDeltaEvent
  | EditorContentEndEvent
  | RetryEvent
  | ContextUpdateEvent
  | DesktopStreamEvent
  | AttachmentStagedEvent
  | WorkspaceReadyEvent
  | SSEErrorEvent;

// --- High-Level Chat Events (SDK → consumer) ---

export type ChatEvent =
  | { type: "connected" }
  | { type: "user_message"; content: string; createdAt?: number }
  | { type: "title_generated"; title: string }
  | { type: "chunk"; text: string }
  | { type: "tool_call"; request: ToolCallRequest }
  | { type: "tool_executing"; name: string; call_id?: string }
  | { type: "tool_completed"; name: string; result: string }
  | {
      type: "tool_progress";
      callId: string;
      tool: string;
      index: number;
      total: number;
      item: { title: string; url: string; snippet?: string };
    }
  | {
      type: "tool_end";
      callId: string;
      toolName: string;
      result?: string;
      sources?: { title: string; url: string; snippet?: string }[];
      durationMs?: number;
    }
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
  | {
      type: "capsule_output";
      toolName: string;
      agentName: string;
      command?: string;
      output: string;
      durationMs?: number;
      callId?: string;
    }
  | {
      type: "capsule_output_chunk";
      callId: string;
      stream: "stdout" | "stderr";
      chunk: string;
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
      metrics?: Record<string, unknown>;
      job_id?: string;
    }
  | {
      type: "subagent_tool_use";
      agentName: string;
      toolName: string;
      toolCallId: string;
      result?: string;
    }
  | {
      type: "asset_created";
      assetId: string;
      name: string;
      url: string;
      mediaType: string;
      sizeBytes: number;
    }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delaySeconds: number;
    }
  | {
      type: "context_update";
      context: Record<string, unknown>;
      phase?: string;
      updatedAt?: number;
    }
  | {
      type: "editor_content_start";
      callId: string;
      path: string;
      language: string;
    }
  | {
      type: "editor_content_delta";
      callId: string;
      path: string;
      delta: string;
    }
  | { type: "editor_content_end"; callId: string }
  | {
      type: "desktop_stream";
      url: string;
      authKey: string;
      sandboxId: string;
    }
  | {
      type: "attachment_staged";
      files: {
        name: string;
        path: string;
        mediaType: string;
        sizeBytes: number;
      }[];
    }
  | {
      type: "workspace_ready";
      conversationId: string;
      sandboxId: string;
    }
  | { type: "model_info"; name: string }
  | { type: "blocks_changed"; blocks: import("./block-builder.js").Block[] }
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
  description?: string;
  arguments?: Record<string, unknown>;
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
  callId?: string;
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
  continue_from_message?: string;
  resend_from?: string;
  upload_ids?: string[];
  agent_name?: string;
  enable_search?: boolean;
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
  displayName?: string;
  description?: string;
  arguments: Record<string, unknown>;
  isClientTool: boolean;
  toolCategory?: string;
  iconUrl?: string;
}

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

export interface ConversationEvent {
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

// --- Send Options ---

export interface SendOptions {
  conversationId?: string;
  enabledClientTools?: string[];
  uploadIds?: string[];
  agentName?: string;
  enableSearch?: boolean;
}

// --- Conversation Assets ---

export interface ConversationAsset {
  id: string;
  kind: "upload" | "output";
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  workspacePath?: string;
  sourceMessageId?: string;
  agentName?: string;
  createdAt: string;
}
