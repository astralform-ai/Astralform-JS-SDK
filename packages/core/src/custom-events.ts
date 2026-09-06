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

/** The conversation's plan, as markdown, after the agent wrote or revised it.
 *  Full body rather than a diff — `write_plan` replaces the document wholesale. */
export interface PlanUpdatePayload {
  plan: string;
}

/** Names of the conversation's notes, after one was written or deleted.
 *  Names only; bodies are unbounded and read on demand. */
export interface NoteUpdatePayload {
  notes: string[];
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

export interface MemoryProviderErrorPayload {
  /** The external memory provider that failed (registry slug, e.g. "mem0"). */
  provider: string;
  /** Which provider operation failed — "save" | "update" | "delete" | "get"
   *  | "recall" | "ingest" | "list_visible" | … Typed as string for forward compat. */
  op: string;
  /** One-line "<ExceptionType>: <message>" detail, length-capped by the backend. */
  error: string;
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

export interface ToolApprovalGrantedPayload {
  toolName: string;
  callId: string;
}

export interface ToolPermissionDeniedPayload {
  toolName: string;
  callId: string;
  reason?: string | null;
  /** Known values: "hook" | "rule" | "user" | "timeout" | "circuit_breaker". */
  deniedBy?: string | null;
}

export interface ToolHarnessWarningPayload {
  toolName: string;
  callId: string;
  message?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ToolProgressPayload {
  callId: string;
  /** Known values: "stdout" | "stderr" | "progress" | "command". Typed as string
   *  for forward compat; the backend defaults to "progress". */
  stream: string;
  /** Live progress text to append; the backend newline-terminates chunks. */
  chunk: string;
  /** Emitting tool, e.g. "web_search" | "deep_research" | "generate_video".
   *  Wire key is `tool`; camelCase here, like the rest of this catalog. */
  toolName?: string | null;
  /** Structured metadata riding alongside `chunk` for a richer UI — a search
   *  result ({title,url,snippet}) or a research phase record. */
  item?: Record<string, unknown> | null;
  /** Position within `total`, when the producer emits one item per step. */
  index?: number | null;
  total?: number | null;
  /** Producers splat arbitrary extra keys (`generate_video` sends `status`,
   *  `preset`), so this payload is open-ended by design. */
  [key: string]: unknown;
}

export interface NestedLlmUsagePayload {
  /** Which tool made the nested calls, e.g. "deep_research". */
  source: string;
  /** The parent tool call these nested calls belong to. */
  callId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  /** Number of nested LLM calls this event aggregates. */
  llmCalls: number;
}

export interface UserUnavailablePayload {
  consecutiveTimeouts: number;
  toolName?: string | null;
}

export interface PromptSuggestionPayload {
  suggestions: string[];
}
