// Core classes
export { AstralformClient } from "./client.js";
export { ChatSession } from "./session.js";
export {
  BlockBuilder,
  type Block,
  type UserBlock,
  type TextBlock,
  type ThinkingBlock,
  type AgentBlock,
  type SubagentBlock,
  type ToolBlock,
  type CapsuleBlock,
  type DesktopStreamBlock,
  type AssetBlock,
  type TodoBlock,
  type EditorBlock,
  type ErrorBlock,
  type EventHandler,
} from "./block-builder.js";
export { standardHandlers } from "./standard-handlers.js";
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

// Constants
export { ChatEventType } from "./types.js";

// Types
export type {
  AstralformConfig,
  MessageStartEvent,
  ContentBlockDeltaEvent,
  ToolUseStartEvent,
  ToolUseEndEvent,
  ToolExecutingEvent,
  ToolProgressEvent,
  AgentStartEvent,
  AgentEndEvent,
  SubagentStartEvent,
  SubagentContentDeltaEvent,
  SubagentEndEvent,
  SubagentToolUseEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  CapsuleOutputEvent,
  CapsuleOutputChunkEvent,
  TodoUpdateEvent,
  MessageStopEvent,
  RetryEvent,
  DesktopStreamEvent,
  SSEErrorEvent,
  SSEEvent,
  ChatEvent,
  Conversation,
  Message,
  ProjectStatus,
  AgentInfo,
  SkillInfo,
  SubagentState,
  ToolState,
  CapsuleOutput,
  Source,
  TodoItem,
  ChatStreamRequest,
  ToolResultRequest,
  ToolResult,
  ToolDefinition,
  ToolCallRequest,
  ConversationAsset,
  StreamJobSSEOptions,
  JobCreateResponse,
  ChatStreamEvent,
  ConversationEvent,
} from "./types.js";
