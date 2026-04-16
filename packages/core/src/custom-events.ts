// =============================================================================
// Custom event payload catalog — typed payloads for wire CustomEvent
//
// Mirrors the Wire Payload Catalog in `backend/src/stream/protocol.py`.
// Each interface defines the `data` contract for a specific custom event
// `name` value. All fields are camelCase (the session translates from
// the backend's snake_case on the wire).
// =============================================================================

// --- Reusable types ---

export interface AgentIdentity {
  name: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  description?: string | null;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoItem {
  id: number;
  subject: string;
  status: TaskStatus;
  description?: string | null;
  activeForm?: string | null;
  owner?: string | null;
  blockedBy?: number[] | null;
  blocks?: number[] | null;
  priority?: number | null;
}

// --- Payload interfaces ---

export interface TodoUpdatePayload {
  todos: TodoItem[];
}

export interface TitleGeneratedPayload {
  title: string;
}

export interface SubagentStartPayload {
  agent: AgentIdentity;
  taskCallId?: string | null;
}

export interface SubagentStopPayload {
  agent: AgentIdentity;
  taskCallId?: string | null;
}

export interface ContextWarningPayload {
  /** Known values: "info" | "warning" | "critical". Typed as string for forward compat. */
  severity: string;
  utilizationPct: number;
  remainingTokens: number;
  windowTokens: number;
  inputTokens: number;
  message: string;
}

export interface ContextUpdatePayload {
  phase?: string | null;
  updatedAt?: number | null;
  context: Record<string, unknown>;
}

/**
 * A single memory entry returned by ``memory_recall``. Backend may add
 * fields over time, so the shape is intentionally open-ended.
 */
export interface MemoryRecord {
  id: string;
  content: string;
  [key: string]: unknown;
}

export interface MemoryRecallPayload {
  memories: MemoryRecord[];
}

export interface MemoryUpdatePayload {
  /** Known values: "created" | "updated" | "deleted". Typed as string for forward compat. */
  action: string;
  memoryId?: string | null;
  key?: string | null;
  namespace?: string | null;
}

export interface DesktopStreamPayload {
  url: string;
  sandboxId?: string | null;
}

export interface AttachmentStagedPayload {
  attachmentId: string;
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
}

export interface WorkspaceReadyPayload {
  sandboxId: string;
  workspacePath?: string | null;
}

export interface AssetCreatedPayload {
  assetId: string;
  filename: string;
  url?: string | null;
  contentType?: string | null;
}

export interface ToolApprovalRequestedPayload {
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
  riskLevel?: string | null;
  reason?: string | null;
}
