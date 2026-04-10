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

// Event type constants
export { ChatEventType } from "./types.js";
export type { ChatEventTypeValue } from "./types.js";

// High-level ChatEvent (SDK → consumer)
export type { ChatEvent, BlockDeltaPayload, TurnUsage } from "./types.js";

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
  AgentInfo,
  SkillInfo,
  TodoItem,
} from "./types.js";

// Request / response types
export type {
  ChatStreamRequest,
  ToolResultRequest,
  ToolResult,
  ToolDefinition,
  ToolCallRequest,
  JobCreateResponse,
  ConversationAsset,
  StreamJobSSEOptions,
  ChatStreamEvent,
  ConversationEvent,
} from "./types.js";
