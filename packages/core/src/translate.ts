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
import type {
  AgentIdentity,
  GoalActionAvailability,
  GoalAvailability,
  MemoryRecord,
  TodoItem,
} from "./custom-events.js";

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

function translateAgentIdentity(raw: unknown): AgentIdentity {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? { ...raw } : {};
  const read = (key: string): unknown => source[key];
  return {
    name: (read("name") as string) ?? "",
    displayName: (read("display_name") as string | null) ?? null,
    avatarUrl: (read("avatar_url") as string | null) ?? null,
    description: (read("description") as string | null) ?? null,
  };
}

/**
 * A subagent run's identity, from EITHER shape the wire has used.
 *
 * The backend's `agent_start` / `agent_stop` carry it FLAT (`agent_name`,
 * `agent_display_name`, `agent_avatar_url` — `backend/src/stream/protocol.py`
 * `AgentRunStartPayload`); the older `subagent_start` / `subagent_stop` frames
 * this translator was written against nested it under `agent`. Reading only the
 * nested shape is what made every frame the current backend emits arrive with an
 * EMPTY identity — the events still reached consumers, they just said nothing.
 */
function agentIdentityFromEvent(data: Record<string, unknown>): AgentIdentity {
  if ("agent" in data) return translateAgentIdentity(data.agent);
  return translateAgentIdentity({
    name: data.agent_name,
    display_name: data.agent_display_name,
    avatar_url: data.agent_avatar_url,
  });
}

/** A string field of a parsed frame, or `undefined` when it is not one. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A number field of a parsed frame, or `undefined` when it is not one. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * One goal-control action's availability, preserved with the server's own
 * vocabulary. `reasonCode` is deliberately not narrowed to a union: a code this
 * SDK predates must reach the consumer, which hides the control, instead of
 * being dropped (or worse, read as its own guess).
 */
function translateGoalAction(value: unknown): GoalActionAvailability | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.allowed !== "boolean") return null;
  const reasonCode = optionalString(raw.reasonCode);
  return reasonCode === undefined
    ? { allowed: raw.allowed }
    : { allowed: raw.allowed, reasonCode };
}

/**
 * The goal's pause/resume availability. A descriptor missing either side is
 * null as a whole: half a contract is not something a client may act on, and
 * a null renders no control.
 */
function translateGoalAvailability(value: unknown): GoalAvailability | null {
  if (value == null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const pause = translateGoalAction(raw.pause);
  const resume = translateGoalAction(raw.resume);
  if (!pause || !resume) return null;
  return { pause, resume };
}

/**
 * Translate a wire TodoItem (snake_case — `active_form`, `blocked_by`,
 * mirroring `backend/src/stream/protocol.py`) into the consumer-facing
 * camelCase shape. The backend emits todos exactly as the payload catalog
 * defines them, so the translation is the single place the casing is fixed;
 * consumers can rely on `todo.activeForm` / `todo.blockedBy` matching the
 * declared types.
 */
function translateTodoItem(raw: Record<string, unknown>): TodoItem {
  return {
    id: (raw.id as number) ?? 0,
    subject: (raw.subject as string) ?? "",
    status: (raw.status as TodoItem["status"]) ?? "pending",
    description: (raw.description as string | null) ?? null,
    activeForm: (raw.active_form as string | null) ?? null,
    owner: (raw.owner as string | null) ?? null,
    blockedBy: (raw.blocked_by as number[] | null) ?? null,
    blocks: (raw.blocks as number[] | null) ?? null,
    priority: (raw.priority as number | null) ?? null,
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
        todos: ((data.todos as unknown[]) ?? []).map((t) =>
          translateTodoItem(t as Record<string, unknown>),
        ),
      };
    case "goal_progress":
      return {
        type: "goal_progress",
        goalId: (data.goal_id as string) ?? "",
        conversationId: (data.conversation_id as string) ?? "",
        objective: optionalString(data.objective) ?? null,
        status: (data.status as string) ?? "unknown",
        settled: (data.settled as boolean) ?? false,
        continuationCount: optionalNumber(data.continuation_count) ?? 0,
        budget: (data.budget as Record<string, unknown> | null) ?? null,
        usage: (data.usage as Record<string, unknown> | null) ?? null,
        progress: (data.progress as Record<string, unknown> | null) ?? null,
        verdict: optionalString(data.verdict) ?? null,
        blocker: optionalString(data.blocker) ?? null,
        stopReason: optionalString(data.stop_reason) ?? null,
        budgetExhaustedDimension: optionalString(data.budget_exhausted_dimension) ?? null,
        availability: translateGoalAvailability(data.availability),
      };
    case "usage_snapshot":
      // Long-horizon phase 3: cumulative in-flight usage for a long turn.
      return {
        type: "usage_snapshot",
        inputTokens: optionalNumber(data.input_tokens) ?? 0,
        outputTokens: optionalNumber(data.output_tokens) ?? 0,
        cacheReadTokens: optionalNumber(data.cache_read_tokens) ?? 0,
        elapsedS: optionalNumber(data.elapsed_s) ?? 0,
        iteration: optionalNumber(data.iteration) ?? 0,
        interruptedTools: optionalNumber(data.interrupted_tools) ?? 0,
      };
    case "plan_update":
      return {
        type: "plan_update",
        plan: (data.plan as string) ?? "",
      };
    case "note_update":
      return {
        type: "note_update",
        notes: (data.notes as string[]) ?? [],
      };
    case "context_update":
      return {
        type: "context_update",
        context: (data.context as Record<string, unknown>) ?? {},
        phase: (data.phase as string | null) ?? null,
        updatedAt: (data.updated_at as number | null) ?? null,
      };
    // Two names for one event: the backend renamed these to `agent_*` (a nested
    // run is not necessarily a "subagent" in the product's vocabulary) while
    // older servers still emit `subagent_*`. Both are translated, so a client
    // works across the rename.
    case "agent_start":
    case "subagent_start":
      return {
        type: "subagent_start",
        runId: optionalString(data.run_id),
        agent: agentIdentityFromEvent(data),
        // `parent_call_id` is the spawn block's call_id — the same key a client
        // uses to find the tool block whose subtree is this child's work.
        taskCallId:
          optionalString(data.parent_call_id) ??
          optionalString(data.task_call_id) ??
          null,
        // Background children only: their own job id, the drill-through key.
        childJobId: optionalString(data.child_job_id),
      };
    case "agent_stop":
    case "subagent_stop":
      return {
        type: "subagent_stop",
        runId: optionalString(data.run_id),
        agent: agentIdentityFromEvent(data),
        taskCallId:
          optionalString(data.parent_call_id) ??
          optionalString(data.task_call_id) ??
          null,
        // The child's OWN spend and outcome, which the wire surfaces separately
        // from the turn totals (`message_stop.usage` folds them in too).
        stopReason: optionalString(data.stop_reason),
        inputTokens: optionalNumber(data.input_tokens),
        outputTokens: optionalNumber(data.output_tokens),
        durationMs: optionalNumber(data.duration_ms),
        childJobId: optionalString(data.child_job_id),
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
    case "memory_provider_error":
      return {
        type: "memory_provider_error",
        provider: (data.provider as string) ?? "",
        op: (data.op as string) ?? "",
        error: (data.error as string) ?? "",
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
    case "tool_harness_warning":
      return {
        type: "tool_harness_warning",
        toolName: (data.tool_name as string) ?? "",
        callId: (data.call_id as string) ?? "",
        message: (data.message as string | null) ?? null,
        details: (data.details as Record<string, unknown> | null) ?? null,
      };
    case "tool_progress":
      return {
        type: "tool_progress",
        callId: (data.call_id as string) ?? "",
        stream: (data.stream as string) ?? "progress",
        chunk: (data.chunk as string) ?? "",
        toolName: (data.tool as string | null) ?? null,
        item: (data.item as Record<string, unknown> | null) ?? null,
        index: (data.index as number | null) ?? null,
        total: (data.total as number | null) ?? null,
        // Every producer sends keys beyond the named ones, and one of them
        // (`video_tool._emit_progress`) splats `**extra`, so no fixed list can
        // be complete. Before this case existed the event fell through to
        // `{type:"custom", name, data}` and consumers read the whole dict;
        // keeping `data` verbatim is what makes the typed variant an addition
        // rather than a narrowing.
        data,
      };
    case "nested_llm_usage":
      return {
        type: "nested_llm_usage",
        source: (data.source as string) ?? "",
        callId: (data.call_id as string) ?? "",
        inputTokens: (data.input_tokens as number) ?? 0,
        outputTokens: (data.output_tokens as number) ?? 0,
        cachedTokens: (data.cached_tokens as number) ?? 0,
        cacheCreationTokens: (data.cache_creation_tokens as number) ?? 0,
        llmCalls: (data.llm_calls as number) ?? 0,
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
 * Legacy-transport payload extractor for events that aren't wrapped in a
 * ``CustomEvent`` envelope. The backend's ``writer.emit(name, data)`` path
 * spreads the payload fields at the top level of the wire object (see
 * ``backend/src/jobs/suggestion_hook.py`` for ``prompt_suggestion``), so
 * the wire object itself *is* the ``data`` dict for ``translateCustomEvent``.
 * This helper isolates the unsafe cast to one place.
 */
function legacyCustomEventData(wire: WireEvent): Record<string, unknown> {
  return wire as unknown as Record<string, unknown>;
}

/**
 * Translate a full WireEvent into its typed ChatEvent counterpart. Returns
 * ``null`` when the wire payload is malformed (e.g. unknown delta channel)
 * so the caller can skip it without crashing the stream.
 */
export function translateWireEvent(wire: WireEvent): ChatEvent | null {
  // Legacy transport: ``prompt_suggestion`` is emitted via the raw
  // ``writer.emit()`` path rather than wrapped in a CustomEvent envelope,
  // so its ``type`` field is the event name itself. Route it through the
  // custom-event translator to keep the mapping in one place.
  if ((wire as { type: string }).type === "prompt_suggestion") {
    return translateCustomEvent(
      "prompt_suggestion",
      legacyCustomEventData(wire),
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
    case "message_stop": {
      const usage = wire.usage ?? {};
      return {
        type: "message_stop",
        turnId: wire.turn_id,
        jobId: wire.job_id,
        stopReason: wire.stop_reason,
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedTokens: usage.cached_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_tokens ?? 0,
        },
        ttfbMs: wire.ttfb_ms,
        totalMs: wire.total_ms,
        stallCount: wire.stall_count,
      };
    }
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
