// =============================================================================
// Astralform SDK v2 type definitions
// =============================================================================
//
// Wire protocol types mirror the Pydantic models in
// `backend/src/stream/protocol.py` 1:1. The SDK forwards typed events to
// the consumer; block construction happens on the consumer side.
//
// Custom event payloads live in `custom-events.ts`.

import type { AgentIdentity, MemoryRecord, TodoItem } from "./custom-events.js";

// Re-export so consumers can import from types.ts or custom-events.ts
export type { AgentIdentity, MemoryRecord, TodoItem };

// --- Configuration ---

export interface AstralformConfig {
  apiKey: string;
  baseURL?: string;
  userId: string;
  fetch?: typeof globalThis.fetch;
}

// --- Event type constants (SDK public) ---
//
// These are the high-level ChatEvent kinds the SDK emits to its
// consumer. The raw wire events below are translated into these
// kinds at the session boundary.

export const ChatEventType = {
  // Connection lifecycle (SDK-local, not wire)
  Connected: "connected",
  Disconnected: "disconnected",

  // Turn lifecycle
  MessageStart: "message_start",
  MessageStop: "message_stop",

  // Block lifecycle
  BlockStart: "block_start",
  BlockDelta: "block_delta",
  BlockStop: "block_stop",

  // Reliability
  Stall: "stall",
  Retry: "retry",
  Error: "error",
  Keepalive: "keepalive",

  // Conversation-level (typed custom events)
  UserMessage: "user_message",
  TitleGenerated: "title_generated",
  TodoUpdate: "todo_update",
  ContextUpdate: "context_update",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  ContextWarning: "context_warning",
  MemoryRecall: "memory_recall",
  MemoryUpdate: "memory_update",
  DesktopStream: "desktop_stream",
  AttachmentStaged: "attachment_staged",
  WorkspaceReady: "workspace_ready",
  AssetCreated: "asset_created",
  ToolApprovalRequested: "tool_approval_requested",
  StateChanged: "state_changed",

  // Generic fallthrough for unknown custom events
  Custom: "custom",
} as const;

export type ChatEventTypeValue =
  (typeof ChatEventType)[keyof typeof ChatEventType];

// =============================================================================
// Wire protocol (matches backend Pydantic models 1:1, snake_case)
// =============================================================================

export type WireBlockKind = "text" | "thinking" | "tool_use";

export type WireBlockStatus =
  | "streaming"
  | "awaiting_client_result"
  | "ok"
  | "error"
  | "denied"
  | "cancelled";

export type WireStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "context_overflow"
  | "error";

// --- BlockDelta payloads (discriminated on `channel`) ---

export interface WireTextDelta {
  channel: "text";
  text: string;
}

export interface WireThinkingDelta {
  channel: "thinking";
  text: string;
}

export interface WireSignatureDelta {
  channel: "signature";
  signature: string;
}

export interface WireInputDelta {
  channel: "input";
  partial_json: string;
}

export interface WireInputArgDelta {
  channel: "input_arg";
  arg_name: string;
  text: string;
}

export interface WireOutputDelta {
  channel: "output";
  stream: "stdout" | "stderr" | "progress";
  chunk: string;
}

export interface WireStatusDelta {
  channel: "status";
  status:
    | "executing"
    | "awaiting_client_result"
    | "awaiting_approval"
    | "denied";
  note?: string;
}

export type WireBlockDeltaPayload =
  | WireTextDelta
  | WireThinkingDelta
  | WireSignatureDelta
  | WireInputDelta
  | WireInputArgDelta
  | WireOutputDelta
  | WireStatusDelta;

// --- Top-level wire events ---

interface WireEnvelope {
  seq: number;
  ts: number;
  job_id: string;
}

export interface WireMessageStart extends WireEnvelope {
  type: "message_start";
  turn_id: string;
  model: string;
  agent_name?: string | null;
  agent_display_name?: string | null;
  agent_avatar_url?: string | null;
}

export interface WireBlockStart extends WireEnvelope {
  type: "block_start";
  turn_id: string;
  path: number[];
  parent_path?: number[] | null;
  kind: WireBlockKind;
  metadata: Record<string, unknown>;
}

export interface WireBlockDelta extends WireEnvelope {
  type: "block_delta";
  turn_id: string;
  path: number[];
  delta: WireBlockDeltaPayload;
}

export interface WireBlockStop extends WireEnvelope {
  type: "block_stop";
  turn_id: string;
  path: number[];
  status: WireBlockStatus;
  final: Record<string, unknown>;
}

export interface WireMessageStop extends WireEnvelope {
  type: "message_stop";
  turn_id: string;
  stop_reason: WireStopReason;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
  };
  ttfb_ms?: number | null;
  total_ms: number;
  stall_count: number;
}

export interface WireStallWarning extends WireEnvelope {
  type: "stall";
  since_last_event_ms: number;
  stall_count: number;
}

export interface WireRetryEvent extends WireEnvelope {
  type: "retry";
  attempt: number;
  reason: string;
  backoff_ms: number;
  strategy?: string | null;
  max_attempts?: number | null;
  context_recovery?: Record<string, unknown> | null;
}

export interface WireErrorEvent extends WireEnvelope {
  type: "error";
  code: string;
  message: string;
  block_path?: number[] | null;
  // Rate limit fields (carried when code == "rate_limit_exceeded")
  retry_after?: number;
  retry_after_sec?: number;
  reset_at?: number | string;
  scope?: string;
  policy_id?: string;
  limit?: number;
  remaining?: number;
  request_id?: string;
}

export interface WireKeepalive extends WireEnvelope {
  type: "keepalive";
  since_last_event_ms: number;
}

export interface WireCustomEvent extends WireEnvelope {
  type: "custom";
  name: string;
  data: Record<string, unknown>;
}

export type WireEvent =
  | WireMessageStart
  | WireBlockStart
  | WireBlockDelta
  | WireBlockStop
  | WireMessageStop
  | WireStallWarning
  | WireRetryEvent
  | WireErrorEvent
  | WireKeepalive
  | WireCustomEvent;

// =============================================================================
// ChatEvent — high-level SDK events (camelCase, emitted to consumers)
// =============================================================================

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type BlockDeltaPayload =
  | { channel: "text"; text: string }
  | { channel: "thinking"; text: string }
  | { channel: "signature"; signature: string }
  | { channel: "input"; partialJson: string }
  | { channel: "inputArg"; argName: string; text: string }
  | {
      channel: "output";
      stream: "stdout" | "stderr" | "progress";
      chunk: string;
    }
  | {
      channel: "status";
      status:
        | "executing"
        | "awaiting_client_result"
        | "awaiting_approval"
        | "denied";
      note?: string;
    };

export type ChatEvent =
  // Connection lifecycle
  | { type: "connected" }
  | { type: "disconnected" }

  // Turn lifecycle
  | {
      type: "message_start";
      turnId: string;
      model: string;
      agentName?: string | null;
      agentDisplayName?: string | null;
      agentAvatarUrl?: string | null;
    }
  | {
      type: "message_stop";
      turnId: string;
      jobId: string;
      stopReason: WireStopReason;
      usage: TurnUsage;
      ttfbMs?: number | null;
      totalMs: number;
      stallCount: number;
    }

  // Block lifecycle
  | {
      type: "block_start";
      turnId: string;
      path: number[];
      parentPath?: number[] | null;
      kind: WireBlockKind;
      metadata: Record<string, unknown>;
    }
  | {
      type: "block_delta";
      turnId: string;
      path: number[];
      delta: BlockDeltaPayload;
    }
  | {
      type: "block_stop";
      turnId: string;
      path: number[];
      status: WireBlockStatus;
      final: Record<string, unknown>;
    }

  // Reliability
  | {
      type: "stall";
      sinceLastEventMs: number;
      stallCount: number;
    }
  | {
      type: "retry";
      attempt: number;
      reason: string;
      backoffMs: number;
      strategy?: string | null;
      maxAttempts?: number | null;
      contextRecovery?: Record<string, unknown> | null;
    }
  | {
      type: "error";
      code: string;
      message: string;
      blockPath: number[] | null;
    }
  | {
      type: "keepalive";
      sinceLastEventMs: number;
    }

  // Conversation-level — typed custom events
  | { type: "user_message"; content: string; createdAt?: number }
  | { type: "title_generated"; title: string }
  | { type: "todo_update"; todos: TodoItem[] }
  | {
      type: "context_update";
      context: Record<string, unknown>;
      phase?: string | null;
      updatedAt?: number | null;
    }
  | {
      type: "subagent_start";
      agent: AgentIdentity;
      taskCallId?: string | null;
    }
  | {
      type: "subagent_stop";
      agent: AgentIdentity;
      taskCallId?: string | null;
    }
  | {
      type: "context_warning";
      /** Known values: "info" | "warning" | "critical". Typed as string for forward compat. */
      severity: string;
      utilizationPct: number;
      remainingTokens: number;
      windowTokens: number;
      inputTokens: number;
      message: string;
    }
  | { type: "memory_recall"; memories: MemoryRecord[] }
  | {
      type: "memory_update";
      /** Known values: "created" | "updated" | "deleted". */
      action: string;
      memoryId?: string | null;
      key?: string | null;
      namespace?: string | null;
    }
  | { type: "desktop_stream"; url: string; sandboxId?: string | null }
  | {
      type: "attachment_staged";
      attachmentId: string;
      filename: string;
      contentType?: string | null;
      sizeBytes?: number | null;
    }
  | {
      type: "workspace_ready";
      sandboxId: string;
      workspacePath?: string | null;
    }
  | {
      type: "asset_created";
      assetId: string;
      filename: string;
      url?: string | null;
      contentType?: string | null;
    }
  | {
      type: "tool_approval_requested";
      toolName: string;
      callId: string;
      arguments: Record<string, unknown>;
      riskLevel?: string | null;
      reason?: string | null;
    }
  | {
      type: "state_changed";
      /**
       * Job lifecycle state. Known values from the backend today include
       * "queued" | "running" | "waiting_for_tool" | "completed" | "failed".
       * Typed as string for forward compat.
       */
      state: string;
    }

  // Generic fallthrough for unknown custom events
  | {
      type: "custom";
      name: string;
      data: Record<string, unknown>;
    };

// =============================================================================
// Domain models (unchanged from previous SDK version)
// =============================================================================

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

export interface UIComponentsConfig {
  enabled: boolean;
  /** Protocol slug (e.g. "a2ui"). Null when disabled. */
  protocol: string | null;
  /** MIME type to match against embedded resources (e.g. "application/json+a2ui"). */
  mimeType: string | null;
}

export interface ProjectStatus {
  isReady: boolean;
  llmConfigured: boolean;
  llmProvider?: string;
  llmModel?: string;
  message: string;
  uiComponents: UIComponentsConfig;
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

// TodoItem is imported from custom-events.ts and re-exported above.

// =============================================================================
// Job and request types
// =============================================================================

export interface JobCreateResponse {
  job_id: string;
  conversation_id: string;
  message_id: string;
  status: string;
}

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
  plan_mode?: boolean;
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

export type ToolApprovalDecision = "allow" | "deny";
export type ToolApprovalScope = "once" | "conversation" | "always";

export interface ToolApprovalRequest {
  job_id: string;
  call_id: string;
  decision: ToolApprovalDecision;
  scope: ToolApprovalScope;
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

// =============================================================================
// SSE transport / raw parsing
// =============================================================================

export interface StreamJobSSEOptions {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetchFn: typeof globalThis.fetch;
}

export interface ChatStreamEvent {
  event: string;
  data: string;
}

export interface ConversationEvent {
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

// =============================================================================
// Send / session options
// =============================================================================

export interface SendOptions {
  conversationId?: string;
  enabledClientTools?: string[];
  uploadIds?: string[];
  agentName?: string;
  enableSearch?: boolean;
  planMode?: boolean;
}

// =============================================================================
// Conversation assets (unchanged)
// =============================================================================

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
