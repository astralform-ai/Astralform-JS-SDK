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

// Utilities
export { generateId } from "./utils.js";

// Streaming
export { streamJobSSE } from "./streaming.js";

// Types
export type {
  AstralformConfig,
  MessageStartEvent,
  ContentBlockDeltaEvent,
  ToolUseStartEvent,
  ToolUseEndEvent,
  AgentStartEvent,
  AgentEndEvent,
  SubagentStartEvent,
  SubagentContentDeltaEvent,
  SubagentEndEvent,
  SubagentToolUseEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  SourcesEvent,
  CapsuleOutputEvent,
  TodoUpdateEvent,
  MessageStopEvent,
  RetryEvent,
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
  SendOptions,
} from "./types.js";
