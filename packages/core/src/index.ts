// Core classes
export { AstralformClient } from "./client.js";
export { ChatSession } from "./session.js";
export { ToolRegistry, type ToolHandler } from "./tools.js";
export { WebMCPBridge } from "./web-mcp.js";
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
export { streamSSE, streamJobSSE } from "./streaming.js";

// Types
export type {
  AstralformConfig,
  MessageStartEvent,
  ContentBlockDeltaEvent,
  ToolUseStartEvent,
  AgentStartEvent,
  AgentEndEvent,
  MessageStopEvent,
  SSEErrorEvent,
  SSEEvent,
  ChatEvent,
  Conversation,
  Message,
  ProjectStatus,
  PlatformTool,
  ServerMCPTool,
  AgentInfo,
  SkillInfo,
  ChatStreamRequest,
  ToolResultRequest,
  ToolResult,
  ToolDefinition,
  ToolCallRequest,
  WebMCPTool,
  WebMCPContext,
  WebMCPToolHandler,
  StreamSSEOptions,
  StreamJobSSEOptions,
  JobCreateResponse,
  ChatStreamEvent,
  SendOptions,
} from "./types.js";
