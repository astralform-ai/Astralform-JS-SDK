// =============================================================================
// Wire → ChatEvent translation
//
// Single source of truth for the pure translation from backend wire types
// (snake_case, mirroring Pydantic) to consumer-facing ChatEvents (camelCase).
// Shared between the live session loop and the persisted-event replay path,
// so adding a new event type only requires updating one place.
// =============================================================================

import type {
  BlockDeltaPayload,
  ChatEvent,
  WireBlockDeltaPayload,
  WireEvent,
} from "./types.js";
import type { MemoryRecord, TodoItem } from "./custom-events.js";

// --- Delta channels ---

/**
 * Translate a WireBlockDeltaPayload into the consumer-facing shape. Returns
 * ``null`` for unknown channels so forward-compatible backends can add new
 * ones without breaking old clients.
 */
export function translateDelta(
  wire: WireBlockDeltaPayload,
): BlockDeltaPayload | null {
  switch (wire.channel) {
    case "text":
      return { channel: "text", text: wire.text };
    case "thinking":
      return { channel: "thinking", text: wire.text };
    case "signature":
      return { channel: "signature", signature: wire.signature };
    case "input":
      return { channel: "input", partialJson: wire.partial_json };
    case "input_arg":
      return {
        channel: "inputArg",
        argName: wire.arg_name,
        text: wire.text,
      };
    case "output":
      return { channel: "output", stream: wire.stream, chunk: wire.chunk };
    case "status":
      return {
        channel: "status",
        status: wire.status,
        note: wire.note,
      };
    default:
      return null;
  }
}

// --- Custom events ---

function translateAgentIdentity(raw: Record<string, unknown>) {
  return {
    name: (raw.name as string) ?? "",
    displayName: (raw.display_name as string | null) ?? null,
    avatarUrl: (raw.avatar_url as string | null) ?? null,
    description: (raw.description as string | null) ?? null,
  };
}

/**
 * Translate a wire custom event (``{type: "custom", name, data}``) into a
 * typed ChatEvent. Unknown names fall through to the generic ``custom``
 * passthrough so consumers can still observe future backends.
 */
export function translateCustomEvent(
  name: string,
  data: Record<string, unknown>,
): ChatEvent {
  switch (name) {
    case "user_message":
      return {
        type: "user_message",
        content: (data.content as string) ?? "",
        createdAt: data.created_at as number | undefined,
      };
    case "title_generated":
      return {
        type: "title_generated",
        title: (data.title as string) ?? "",
      };
    case "todo_update":
      return {
        type: "todo_update",
        todos: (data.todos as TodoItem[]) ?? [],
      };
    case "context_update":
      return {
        type: "context_update",
        context: (data.context as Record<string, unknown>) ?? {},
        phase: (data.phase as string | null) ?? null,
        updatedAt: (data.updated_at as number | null) ?? null,
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        agent: translateAgentIdentity(
          (data.agent as Record<string, unknown>) ?? {},
        ),
        taskCallId: (data.task_call_id as string | null) ?? null,
      };
    case "subagent_stop":
      return {
        type: "subagent_stop",
        agent: translateAgentIdentity(
          (data.agent as Record<string, unknown>) ?? {},
        ),
        taskCallId: (data.task_call_id as string | null) ?? null,
      };
    case "context_warning":
      return {
        type: "context_warning",
        severity: (data.severity as string) ?? "warning",
        utilizationPct: (data.utilization_pct as number) ?? 0,
        remainingTokens: (data.remaining_tokens as number) ?? 0,
        windowTokens: (data.window_tokens as number) ?? 0,
        inputTokens: (data.input_tokens as number) ?? 0,
        message: (data.message as string) ?? "",
      };
    case "memory_recall":
      return {
        type: "memory_recall",
        memories: (data.memories as MemoryRecord[] | undefined) ?? [],
      };
    case "memory_update":
      return {
        type: "memory_update",
        action: (data.action as string) ?? "",
        memoryId: (data.memory_id as string | null) ?? null,
        key: (data.key as string | null) ?? null,
        namespace: (data.namespace as string | null) ?? null,
      };
    case "desktop_stream":
      return {
        type: "desktop_stream",
        url: (data.url as string) ?? "",
        sandboxId: (data.sandbox_id as string | null) ?? null,
      };
    case "attachment_staged":
      return {
        type: "attachment_staged",
        attachmentId: (data.attachment_id as string) ?? "",
        filename: (data.filename as string) ?? "",
        contentType: (data.content_type as string | null) ?? null,
        sizeBytes: (data.size_bytes as number | null) ?? null,
      };
    case "workspace_ready":
      return {
        type: "workspace_ready",
        sandboxId: (data.sandbox_id as string) ?? "",
        workspacePath: (data.workspace_path as string | null) ?? null,
      };
    case "asset_created":
      return {
        type: "asset_created",
        assetId: (data.asset_id as string) ?? "",
        filename: (data.filename as string) ?? "",
        url: (data.url as string | null) ?? null,
        contentType: (data.content_type as string | null) ?? null,
      };
    case "tool_approval_requested":
      return {
        type: "tool_approval_requested",
        toolName: (data.tool_name as string) ?? "",
        callId: (data.call_id as string) ?? "",
        arguments: (data.arguments as Record<string, unknown>) ?? {},
        riskLevel: (data.risk_level as string | null) ?? null,
        reason: (data.reason as string | null) ?? null,
      };
    case "tool_approval_granted":
      return {
        type: "tool_approval_granted",
        toolName: (data.tool_name as string) ?? "",
        callId: (data.call_id as string) ?? "",
      };
    case "tool_permission_denied":
      return {
        type: "tool_permission_denied",
        toolName: (data.tool_name as string) ?? "",
        callId: (data.call_id as string) ?? "",
        reason: (data.reason as string | null) ?? null,
        deniedBy: (data.denied_by as string | null) ?? null,
      };
    case "tool_harness_warning":
      return {
        type: "tool_harness_warning",
        toolName: (data.tool_name as string) ?? "",
        callId: (data.call_id as string) ?? "",
        message: (data.message as string | null) ?? null,
        details: (data.details as Record<string, unknown> | null) ?? null,
      };
    case "user_unavailable":
      return {
        type: "user_unavailable",
        consecutiveTimeouts: (data.consecutive_timeouts as number) ?? 0,
        toolName: (data.tool_name as string | null) ?? null,
      };
    case "prompt_suggestion":
      return {
        type: "prompt_suggestion",
        suggestions: (data.suggestions as string[]) ?? [],
      };
    case "state_changed":
      return {
        type: "state_changed",
        state: (data.state as string) ?? "",
      };
    default:
      return { type: "custom", name, data };
  }
}

// --- Top-level wire events ---

/**
 * Translate a full WireEvent into its typed ChatEvent counterpart. Returns
 * ``null`` when the wire payload is malformed (e.g. unknown delta channel)
 * so the caller can skip it without crashing the stream.
 */
export function translateWireEvent(wire: WireEvent): ChatEvent | null {
  // Legacy transport: `prompt_suggestion` is emitted via the raw
  // writer.emit() path rather than wrapped in a CustomEvent envelope,
  // so its `type` field is the event name itself. Route it through the
  // custom-event translator to keep the mapping in one place.
  if ((wire as { type: string }).type === "prompt_suggestion") {
    return translateCustomEvent(
      "prompt_suggestion",
      wire as unknown as Record<string, unknown>,
    );
  }
  switch (wire.type) {
    case "message_start":
      return {
        type: "message_start",
        turnId: wire.turn_id,
        model: wire.model,
        agentName: wire.agent_name,
        agentDisplayName: wire.agent_display_name,
        agentAvatarUrl: wire.agent_avatar_url,
      };
    case "block_start":
      return {
        type: "block_start",
        turnId: wire.turn_id,
        path: wire.path,
        parentPath: wire.parent_path ?? null,
        kind: wire.kind,
        metadata: wire.metadata,
      };
    case "block_delta": {
      const delta = translateDelta(wire.delta);
      if (!delta) return null;
      return {
        type: "block_delta",
        turnId: wire.turn_id,
        path: wire.path,
        delta,
      };
    }
    case "block_stop":
      return {
        type: "block_stop",
        turnId: wire.turn_id,
        path: wire.path,
        status: wire.status,
        final: wire.final,
      };
    case "message_stop":
      return {
        type: "message_stop",
        turnId: wire.turn_id,
        jobId: wire.job_id,
        stopReason: wire.stop_reason,
        usage: {
          inputTokens: wire.usage.input_tokens ?? 0,
          outputTokens: wire.usage.output_tokens ?? 0,
          cachedTokens: wire.usage.cached_tokens ?? 0,
        },
        ttfbMs: wire.ttfb_ms,
        totalMs: wire.total_ms,
        stallCount: wire.stall_count,
      };
    case "stall":
      return {
        type: "stall",
        sinceLastEventMs: wire.since_last_event_ms,
        stallCount: wire.stall_count,
      };
    case "retry":
      return {
        type: "retry",
        attempt: wire.attempt,
        reason: wire.reason,
        backoffMs: wire.backoff_ms,
        strategy: wire.strategy ?? null,
        maxAttempts: wire.max_attempts ?? null,
        contextRecovery: wire.context_recovery ?? null,
      };
    case "error":
      return {
        type: "error",
        code: wire.code,
        message: wire.message,
        blockPath: wire.block_path ?? null,
      };
    case "keepalive":
      return {
        type: "keepalive",
        sinceLastEventMs: wire.since_last_event_ms,
      };
    case "custom":
      return translateCustomEvent(wire.name, wire.data);
    default: {
      // Exhaustive guard — a new WireEvent variant should force this switch
      // to be updated at compile time.
      const _exhaustive: never = wire;
      void _exhaustive;
      return null;
    }
  }
}
