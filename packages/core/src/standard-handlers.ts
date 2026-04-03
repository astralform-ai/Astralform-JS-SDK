/**
 * Standard event handlers for BlockBuilder.
 *
 * These define the default event→block mapping rules. Clients import
 * and register them explicitly:
 *
 *   import { BlockBuilder, standardHandlers } from "@astralform/js";
 *   const builder = new BlockBuilder();
 *   builder.registerHandlers(standardHandlers);
 */

import type {
  AttachmentBlock,
  BlockBuilder,
  CapsuleBlock,
  DesktopStreamBlock,
  EditorBlock,
  EventHandler,
  SubagentBlock,
  TextBlock,
  ThinkingBlock,
  TodoBlock,
  ToolBlock,
  UserBlock,
} from "./block-builder.js";
import type { ChatEvent } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function finalizeText(builder: BlockBuilder): void {
  if (builder.activeTextId) {
    builder.patchBlock(builder.activeTextId, {
      isStreaming: false,
    } as Partial<TextBlock>);
    builder.activeTextId = null;
  }
}

function finalizeThinking(builder: BlockBuilder): void {
  if (builder.activeThinkingId) {
    builder.patchBlock(builder.activeThinkingId, {
      isActive: false,
    } as Partial<ThinkingBlock>);
    builder.activeThinkingId = null;
    builder.thinkingStartMs = null;
  }
}

function finalizeEditor(builder: BlockBuilder): void {
  if (builder.activeEditorId) {
    builder.patchBlock(builder.activeEditorId, {
      isStreaming: false,
    } as Partial<EditorBlock>);
    builder.activeEditorId = null;
  }
}

// ── Text streaming ──────────────────────────────────────────────────

// ── User message ────────────────────────────────────────────────────

const handleUserMessage: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "user_message" };
  // Skip if user block already exists (optimistic add from frontend),
  // but patch createdAt if the server provides it
  const existing = builder.findBlock((b) => b.type === "user");
  if (existing) {
    if (e.createdAt) {
      builder.patchBlock(existing.id, {
        createdAt: e.createdAt,
      } as Partial<UserBlock>);
    }
    return;
  }
  builder.addBlock({
    type: "user",
    id: builder.nextId(),
    content: e.content,
    createdAt: e.createdAt,
  });
};

// ── Text streaming ──────────────────────────────────────────────────

const handleChunk: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "chunk" };
  if (!builder.activeTextId) {
    const id = builder.nextId();
    builder.activeTextId = id;
    builder.addBlock({
      type: "text",
      id,
      content: e.text,
      isStreaming: true,
    });
  } else {
    const id = builder.activeTextId;
    const existing = builder.findBlock((b) => b.id === id);
    if (existing && existing.type === "text") {
      builder.patchBlock(id, {
        content: existing.content + e.text,
      } as Partial<TextBlock>);
    }
  }
};

// ── Tool calls ──────────────────────────────────────────────────────

const handleToolCall: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "tool_call" };
  finalizeText(builder);
  builder.addBlock({
    type: "tool",
    id: builder.nextId(),
    callId: e.request.callId,
    toolName: e.request.toolName,
    displayName: e.request.displayName,
    description: e.request.description,
    arguments: e.request.arguments,
    toolCategory: e.request.toolCategory,
    iconUrl: e.request.iconUrl,
    status: "calling",
  });
};

const handleToolExecuting: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "tool_executing"; call_id?: string };
  const block = builder.findBlock(
    (b) =>
      b.type === "tool" &&
      (e.call_id ? b.callId === e.call_id : b.toolName === e.name) &&
      b.status === "calling",
  );
  if (block) {
    builder.patchBlock(block.id, { status: "executing" } as Partial<ToolBlock>);
  }
};

const handleToolProgress: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "tool_progress" };
  const block = builder.findBlock(
    (b) => b.type === "tool" && b.callId === e.callId,
  );
  if (block && block.type === "tool") {
    const sources = block.sources ? [...block.sources] : [];
    sources.push(e.item);
    builder.patchBlock(block.id, {
      sources,
      status: "executing",
    } as Partial<ToolBlock>);
  }
};

const handleToolEnd: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "tool_completed" | "tool_end" };
  const callId =
    e.type === "tool_end"
      ? (e as ChatEvent & { type: "tool_end" }).callId
      : undefined;
  const name =
    e.type === "tool_end"
      ? (e as ChatEvent & { type: "tool_end" }).toolName
      : (e as ChatEvent & { type: "tool_completed" }).name;

  const block = builder.findBlock(
    (b) =>
      b.type === "tool" &&
      (callId ? b.callId === callId : b.toolName === name) &&
      b.status !== "completed",
  );
  if (block) {
    const toolEnd =
      e.type === "tool_end" ? (e as ChatEvent & { type: "tool_end" }) : null;
    builder.patchBlock(block.id, {
      status: "completed",
      ...(toolEnd?.sources ? { sources: toolEnd.sources } : {}),
      ...(toolEnd?.durationMs != null
        ? { durationMs: toolEnd.durationMs }
        : {}),
      ...(toolEnd?.result ? { result: toolEnd.result } : {}),
    } as Partial<ToolBlock>);
  }
};

// ── Agent lifecycle ─────────────────────────────────────────────────

const handleAgentStart: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "agent_start" };
  finalizeText(builder);
  builder.addBlock({
    type: "agent",
    id: builder.nextId(),
    agentName: e.agentName,
    displayName: e.agentDisplayName,
    avatarUrl: e.avatarUrl,
  });
};

// ── Thinking ────────────────────────────────────────────────────────

const handleThinkingDelta: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "thinking_delta" };
  if (!builder.activeThinkingId) {
    const id = builder.nextId();
    builder.activeThinkingId = id;
    builder.thinkingStartMs = Date.now();
    builder.addBlock({
      type: "thinking",
      id,
      content: e.text,
      isActive: true,
    });
  } else {
    const id = builder.activeThinkingId;
    const existing = builder.findBlock((b) => b.id === id);
    if (existing && existing.type === "thinking") {
      builder.patchBlock(id, {
        content: existing.content + e.text,
      } as Partial<ThinkingBlock>);
    }
  }
};

const handleThinkingComplete: EventHandler = (_event, builder) => {
  if (builder.activeThinkingId) {
    const durationMs = builder.thinkingStartMs
      ? Math.max(0, Date.now() - builder.thinkingStartMs)
      : undefined;
    builder.patchBlock(builder.activeThinkingId, {
      isActive: false,
      durationMs,
    } as Partial<ThinkingBlock>);
    builder.activeThinkingId = null;
    builder.thinkingStartMs = null;
  }
};

// ── Subagents ───────────────────────────────────────────────────────

const handleSubagentStart: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "subagent_start" };
  finalizeText(builder);
  builder.addBlock({
    type: "subagent",
    id: builder.nextId(),
    agentName: e.agentName,
    displayName: e.displayName,
    toolCallId: e.toolCallId,
    avatarUrl: e.avatarUrl,
    description: e.description,
    content: "",
    isActive: true,
  });
};

const handleSubagentChunk: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "subagent_chunk" };
  const block = builder.findBlock(
    (b) => b.type === "subagent" && b.toolCallId === e.toolCallId,
  );
  if (block && block.type === "subagent") {
    builder.patchBlock(block.id, {
      content: block.content + e.text,
    } as Partial<SubagentBlock>);
  }
};

const handleSubagentUpdate: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "subagent_update" };
  const block = builder.findBlock(
    (b) => b.type === "subagent" && b.toolCallId === e.toolCallId,
  );
  if (block) {
    builder.patchBlock(block.id, {
      displayName: e.displayName,
    } as Partial<SubagentBlock>);
  }
};

const handleSubagentEnd: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "subagent_end" };
  const block = builder.findBlock(
    (b) => b.type === "subagent" && b.toolCallId === e.toolCallId,
  );
  if (block) {
    builder.patchBlock(block.id, {
      isActive: false,
    } as Partial<SubagentBlock>);
  }
};

// ── Completion / Error / Disconnect ─────────────────────────────────

const handleComplete: EventHandler = (_event, builder) => {
  finalizeText(builder);
  finalizeThinking(builder);
  finalizeEditor(builder);
  for (const b of builder.getBlocks()) {
    if (b.type === "tool" && b.status !== "completed") {
      builder.patchBlock(b.id, { status: "completed" } as Partial<ToolBlock>);
    }
  }
};

const handleError: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "error" };
  finalizeText(builder);
  finalizeThinking(builder);
  builder.addBlock({
    type: "error",
    id: builder.nextId(),
    message: e.error.message,
  });
};

const handleDisconnected: EventHandler = (_event, builder) => {
  finalizeText(builder);
  finalizeThinking(builder);
  finalizeEditor(builder);
};

// ── Capsule output ──────────────────────────────────────────────────

const handleCapsuleOutputChunk: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "capsule_output_chunk" };
  const block = builder.findBlock(
    (b) => b.type === "capsule" && b.callId === e.callId,
  );
  if (block && block.type === "capsule") {
    builder.patchBlock(block.id, {
      output: block.output + e.chunk,
    } as Partial<CapsuleBlock>);
  } else {
    builder.addBlock({
      type: "capsule",
      id: builder.nextId(),
      callId: e.callId,
      toolName: "",
      output: e.chunk,
      isActive: true,
    });
  }
};

const handleCapsuleOutput: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "capsule_output" };
  const block = builder.findBlock(
    (b) => b.type === "capsule" && b.callId === (e.callId ?? ""),
  );
  if (block) {
    builder.patchBlock(block.id, {
      output: e.output,
      command: e.command,
      toolName: e.toolName,
      durationMs: e.durationMs,
      isActive: false,
    } as Partial<CapsuleBlock>);
  } else {
    builder.addBlock({
      type: "capsule",
      id: builder.nextId(),
      callId: e.callId ?? "",
      toolName: e.toolName,
      command: e.command,
      output: e.output,
      durationMs: e.durationMs,
      isActive: false,
    });
  }
};

// ── Assets ──────────────────────────────────────────────────────────

const handleAssetCreated: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "asset_created" };
  builder.addBlock({
    type: "asset",
    id: builder.nextId(),
    assetId: e.assetId,
    name: e.name,
    url: e.url,
    mediaType: e.mediaType,
    sizeBytes: e.sizeBytes,
  });
};

// ── Todos ───────────────────────────────────────────────────────────

const handleTodoUpdate: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "todo_update" };
  if (builder.activeTodoId) {
    builder.patchBlock(builder.activeTodoId, {
      todos: e.todos,
    } as Partial<TodoBlock>);
  } else {
    const id = builder.nextId();
    builder.activeTodoId = id;
    builder.addBlock({
      type: "todo",
      id,
      todos: e.todos,
    });
  }
};

// ── Editor content ──────────────────────────────────────────────────

const handleEditorContentStart: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "editor_content_start" };
  const id = builder.nextId();
  builder.activeEditorId = id;
  builder.addBlock({
    type: "editor",
    id,
    callId: e.callId,
    path: e.path,
    language: e.language,
    content: "",
    isStreaming: true,
  });
};

const handleEditorContentDelta: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "editor_content_delta" };
  const block = builder.findBlock(
    (b) => b.type === "editor" && b.callId === e.callId,
  );
  if (block && block.type === "editor") {
    builder.patchBlock(block.id, {
      content: block.content + e.delta,
    } as Partial<EditorBlock>);
  }
};

const handleEditorContentEnd: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "editor_content_end" };
  const block = builder.findBlock(
    (b) => b.type === "editor" && b.callId === e.callId,
  );
  if (block) {
    builder.patchBlock(block.id, {
      isStreaming: false,
    } as Partial<EditorBlock>);
  }
  builder.activeEditorId = null;
};

// ── Desktop stream ───────────────────────────────────────────────────

const handleDesktopStream: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "desktop_stream" };
  if (!e.url) return;
  const existing = builder.findBlock((b) => b.type === "desktop_stream");
  if (existing) {
    builder.patchBlock(existing.id, {
      url: e.url,
      authKey: e.authKey,
      sandboxId: e.sandboxId,
    } as Partial<DesktopStreamBlock>);
  } else {
    builder.addBlock({
      type: "desktop_stream",
      id: builder.nextId(),
      url: e.url,
      authKey: e.authKey,
      sandboxId: e.sandboxId,
    });
  }
};

// ── Attachment staged ────────────────────────────────────────────────

const handleAttachmentStaged: EventHandler = (event, builder) => {
  const e = event as ChatEvent & { type: "attachment_staged" };
  if (!e.files || e.files.length === 0) return;
  builder.addBlock({
    type: "attachment",
    id: builder.nextId(),
    files: e.files,
  } as AttachmentBlock);
};

// ── Lifecycle no-ops (intentionally handled, no blocks produced) ────

const noop: EventHandler = () => {};

// ── Exported handler map ────────────────────────────────────────────

export const standardHandlers: Record<string, EventHandler> = {
  user_message: handleUserMessage,
  chunk: handleChunk,
  tool_call: handleToolCall,
  tool_executing: handleToolExecuting,
  tool_progress: handleToolProgress,
  tool_completed: handleToolEnd,
  tool_end: handleToolEnd,
  agent_start: handleAgentStart,
  agent_end: noop,
  thinking_delta: handleThinkingDelta,
  thinking_complete: handleThinkingComplete,
  subagent_start: handleSubagentStart,
  subagent_chunk: handleSubagentChunk,
  subagent_update: handleSubagentUpdate,
  subagent_end: handleSubagentEnd,
  subagent_tool_use: noop,
  capsule_output: handleCapsuleOutput,
  capsule_output_chunk: handleCapsuleOutputChunk,
  asset_created: handleAssetCreated,
  todo_update: handleTodoUpdate,
  editor_content_start: handleEditorContentStart,
  editor_content_delta: handleEditorContentDelta,
  editor_content_end: handleEditorContentEnd,
  desktop_stream: handleDesktopStream,
  attachment_staged: handleAttachmentStaged,
  workspace_ready: noop,
  retry: noop,
  complete: handleComplete,
  error: handleError,
  disconnected: handleDisconnected,
};
