// Core classes
export { AstralformClient } from "./client.js";
export { ChatSession } from "./session.js";
export { ToolRegistry, type ToolHandler } from "./tools.js";
export { InMemoryStorage, type ChatStorage } from "./storage.js";

// Errors
export {
  AstralformError,
  AuthenticationError,
  RateLimitError,
  LLMNotConfiguredError,
  ServerError,
  ConnectionError,
  StreamAbortedError,
} from "./errors.js";
export type { RateLimitErrorDetails } from "./errors.js";

// Utilities
export { generateId } from "./utils.js";

// Streaming
export { streamJobSSE } from "./streaming.js";

// Stream manager
export { StreamManager } from "./stream-manager.js";
export type {
  StreamState,
  SendOptions,
  StreamManagerEvent,
} from "./stream-manager.js";

// Delta translator (shared between session and replay)
export { translateDelta } from "./translate.js";

// Event replay (for restoring conversations from persisted events)
export { mapSseToChat, replayEvents } from "./replay.js";
export type { RawSseEvent } from "./replay.js";

// Embedded resource detection (protocol-agnostic UI surface helper)
export {
  isEmbeddedResource,
  parseEmbeddedResource,
} from "./embedded-resource.js";
export type { EmbeddedResource } from "./embedded-resource.js";

// Protocol adapter registry — consumers register framework-specific
// renderers for embedded resource MIME types.
export { ProtocolRegistry } from "./protocol-registry.js";
export type { ProtocolAdapter } from "./protocol-registry.js";

// Event type constants
export { ChatEventType } from "./types.js";
export type { ChatEventTypeValue } from "./types.js";

// High-level ChatEvent (SDK → consumer)
export type { ChatEvent, BlockDeltaPayload, TurnUsage } from "./types.js";

// Custom event payload catalog
export type {
  AgentIdentity,
  TaskStatus,
  TodoItem,
  TodoUpdatePayload,
  TitleGeneratedPayload,
  SubagentStartPayload,
  SubagentStopPayload,
  ContextWarningPayload,
  ContextUpdatePayload,
  MemoryRecord,
  MemoryRecallPayload,
  MemoryUpdatePayload,
  DesktopStreamPayload,
  AttachmentStagedPayload,
  WorkspaceReadyPayload,
  AssetCreatedPayload,
  ToolApprovalRequestedPayload,
  ToolApprovalGrantedPayload,
  ToolPermissionDeniedPayload,
  ToolHarnessWarningPayload,
  UserUnavailablePayload,
  PromptSuggestionPayload,
} from "./custom-events.js";

// Wire protocol types (for consumers that want to parse the raw SSE
// data themselves or write their own transport adapter)
export type {
  WireEvent,
  WireMessageStart,
  WireMessageStop,
  WireBlockStart,
  WireBlockDelta,
  WireBlockStop,
  WireStallWarning,
  WireRetryEvent,
  WireErrorEvent,
  WireKeepalive,
  WireCustomEvent,
  WireBlockKind,
  WireBlockStatus,
  WireStopReason,
  WireBlockDeltaPayload,
  WireTextDelta,
  WireThinkingDelta,
  WireSignatureDelta,
  WireInputDelta,
  WireInputArgDelta,
  WireOutputDelta,
  WireStatusDelta,
} from "./types.js";

// Config + domain models
export type {
  AstralformConfig,
  Conversation,
  Message,
  ProjectStatus,
  UIComponentsConfig,
  AgentInfo,
  SkillInfo,
} from "./types.js";

// Request / response types
export type {
  ChatStreamRequest,
  ToolResultRequest,
  ToolResult,
  ToolDefinition,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalScope,
  ToolCallRequest,
  JobCreateResponse,
  JobStatus,
  JobSummary,
  ActiveJob,
  FeedbackRequest,
  FeedbackResponse,
  ConversationAsset,
  StreamJobSSEOptions,
  ChatStreamEvent,
  ConversationEvent,
} from "./types.js";
