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

import type { BlockBuilder, EventHandler } from "./block-builder.js";
import type { ChatEvent } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function finalizeText(builder: BlockBuilder): void {
  if (builder.activeTextId) {
    builder.patchBlock(builder.activeTextId, {
      isStreaming: false,
    } as Partial<import("./block-builder.js").TextBlock>);
    builder.activeTextId = null;
  }
}

function finalizeThinking(builder: BlockBuilder): void {
  if (builder.activeThinkingId) {
    builder.patchBlock(builder.activeThinkingId, {
      isActive: false,
    } as Partial<import("./block-builder.js").ThinkingBlock>);
    builder.activeThinkingId = null;
    builder.thinkingStartMs = null;
  }
}

// ── Text streaming ──────────────────────────────────────────────────

// ── User message ────────────────────────────────────────────────────

const handleUserMessage: EventHandler = (event, builder) => {
  // Skip if user block already exists (optimistic add from frontend)
  if (builder.findBlock((b) => b.type === "user")) return;
  const e = event as ChatEvent & { type: "user_message" };
  builder.addBlock({ type: "user", id: builder.nextId(), content: e.content });
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
      } as Partial<import("./block-builder.js").TextBlock>);
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
  const e = event as ChatEvent & { type: "tool_executing" };
  const block = builder.findBlock(
    (b) => b.type === "tool" && b.toolName === e.name && b.status === "calling",
  );
  if (block) {
    builder.patchBlock(block.id, { status: "executing" } as Partial<
      import("./block-builder.js").ToolBlock
    >);
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
    } as Partial<import("./block-builder.js").ToolBlock>);
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
      } as Partial<import("./block-builder.js").ThinkingBlock>);
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
    } as Partial<import("./block-builder.js").ThinkingBlock>);
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
    } as Partial<import("./block-builder.js").SubagentBlock>);
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
    } as Partial<import("./block-builder.js").SubagentBlock>);
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
    } as Partial<import("./block-builder.js").SubagentBlock>);
  }
};

// ── Completion / Error / Disconnect ─────────────────────────────────

const handleComplete: EventHandler = (_event, builder) => {
  finalizeText(builder);
  finalizeThinking(builder);
  for (const b of builder.getBlocks()) {
    if (b.type === "tool" && b.status !== "completed") {
      builder.patchBlock(b.id, { status: "completed" } as Partial<
        import("./block-builder.js").ToolBlock
      >);
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
};

// ── Exported handler map ────────────────────────────────────────────

export const standardHandlers: Record<string, EventHandler> = {
  user_message: handleUserMessage,
  chunk: handleChunk,
  tool_call: handleToolCall,
  tool_executing: handleToolExecuting,
  tool_completed: handleToolEnd,
  tool_end: handleToolEnd,
  agent_start: handleAgentStart,
  thinking_delta: handleThinkingDelta,
  thinking_complete: handleThinkingComplete,
  subagent_start: handleSubagentStart,
  subagent_chunk: handleSubagentChunk,
  subagent_update: handleSubagentUpdate,
  subagent_end: handleSubagentEnd,
  complete: handleComplete,
  error: handleError,
  disconnected: handleDisconnected,
};
