import { describe, it, expect } from "vitest";
import { translateCustomEvent, translateWireEvent } from "../src/translate.js";
import type { WireEvent } from "../src/types.js";

describe("translateCustomEvent", () => {
  // The backend has emitted these since the plan/note tools shipped; the SDK dropped both
  // at `default: return null`, so a plan written at minute 1 of a 13-minute job stayed
  // invisible until the turn ended and a REST read replaced it.
  it("maps plan_update", () => {
    const ev = translateCustomEvent("plan_update", { plan: "# Step 1\nDo the thing" });
    expect(ev).toEqual({ type: "plan_update", plan: "# Step 1\nDo the thing" });
  });

  it("maps note_update", () => {
    const ev = translateCustomEvent("note_update", { notes: ["research", "decisions"] });
    expect(ev).toEqual({ type: "note_update", notes: ["research", "decisions"] });
  });

  it("defaults a plan_update with no body to an empty string, not null", () => {
    // A plan can legitimately be cleared. Dropping the event would leave the panel showing
    // a plan that no longer exists.
    expect(translateCustomEvent("plan_update", {})).toEqual({ type: "plan_update", plan: "" });
  });

  it("defaults note_update to an empty list", () => {
    expect(translateCustomEvent("note_update", {})).toEqual({ type: "note_update", notes: [] });
  });

  it("maps tool_approval_granted", () => {
    const ev = translateCustomEvent("tool_approval_granted", {
      tool_name: "read_file",
      call_id: "call-1",
    });
    expect(ev).toEqual({
      type: "tool_approval_granted",
      toolName: "read_file",
      callId: "call-1",
    });
  });

  it("does NOT type tool_permission_denied — the event cannot reach a client", () => {
    // The translator was removed in 9.0.0. The backend routes this name
    // through `_BLOCK_MUTATING_CUSTOM_NAMES`, whose handler sets
    // `block.denied_by` / `block.denial_kind` and closes the block via
    // `block_stop`; the branch that would forward a custom event to the wire
    // is the `elif` below it, and unlike its two siblings in that set this
    // one emits no `WireCustomEvent`. So the case could never fire, and a
    // client waiting for it showed a denial with no reason.
    //
    // The denial is read off `block_stop.final` — `denied_by` for the prose,
    // `denial_kind` for the token. Pinned here as the raw passthrough rather
    // than deleted outright: if the backend ever did forward this name, the
    // data must still reach the consumer untyped rather than vanish.
    const ev = translateCustomEvent("tool_permission_denied", {
      tool_name: "rm",
      call_id: "call-9",
      reason: "Matched dangerous pattern",
      denied_by: "rule",
    });
    expect(ev).toEqual({
      type: "custom",
      name: "tool_permission_denied",
      data: {
        tool_name: "rm",
        call_id: "call-9",
        reason: "Matched dangerous pattern",
        denied_by: "rule",
      },
    });
  });

  it("maps tool_harness_warning with details", () => {
    const ev = translateCustomEvent("tool_harness_warning", {
      tool_name: "shell",
      call_id: "call-3",
      message: "Output truncated",
      details: { bytes: 4096 },
    });
    expect(ev).toEqual({
      type: "tool_harness_warning",
      toolName: "shell",
      callId: "call-3",
      message: "Output truncated",
      details: { bytes: 4096 },
    });
  });

  it("maps user_unavailable with consecutive_timeouts", () => {
    const ev = translateCustomEvent("user_unavailable", {
      consecutive_timeouts: 3,
      tool_name: "approve_refund",
    });
    expect(ev).toEqual({
      type: "user_unavailable",
      consecutiveTimeouts: 3,
      toolName: "approve_refund",
    });
  });

  it("maps todo_update, translating snake_case todos to camelCase", () => {
    // Regression pin for https://github.com/astralform-ai/Astralform-JS-SDK/issues/16:
    // the backend emits `active_form` / `blocked_by` (protocol.py TodoItem), but the
    // typed surface is camelCase. The payload must be translated, not passed through.
    const ev = translateCustomEvent("todo_update", {
      todos: [
        {
          id: 1,
          subject: "Ship the SDK fix",
          status: "in_progress",
          description: "Normalize todo payload keys",
          active_form: "Shipping the fix",
          owner: "atom2ueki",
          blocked_by: [2],
          blocks: [3],
          priority: 1,
        },
        {
          id: 2,
          subject: "Open the PR",
          status: "pending",
          active_form: null,
          blocked_by: null,
        },
      ],
    });
    expect(ev).toEqual({
      type: "todo_update",
      todos: [
        {
          id: 1,
          subject: "Ship the SDK fix",
          status: "in_progress",
          description: "Normalize todo payload keys",
          activeForm: "Shipping the fix",
          owner: "atom2ueki",
          blockedBy: [2],
          blocks: [3],
          priority: 1,
        },
        {
          id: 2,
          subject: "Open the PR",
          status: "pending",
          description: null,
          activeForm: null,
          owner: null,
          blockedBy: null,
          blocks: null,
          priority: null,
        },
      ],
    });
  });

  it("defaults todo_update with no todos to an empty list", () => {
    expect(translateCustomEvent("todo_update", {})).toEqual({
      type: "todo_update",
      todos: [],
    });
  });

  it("maps prompt_suggestion via custom envelope", () => {
    const ev = translateCustomEvent("prompt_suggestion", {
      suggestions: ["Try X", "Ask about Y"],
    });
    expect(ev).toEqual({
      type: "prompt_suggestion",
      suggestions: ["Try X", "Ask about Y"],
    });
  });

  // Backend custom events that reach the wire as {type:"custom", name, data} but were
  // missing from translateCustomEvent's typed cases, so consumers received them under
  // the generic passthrough and had to cast `data` to read them (composite memory
  // provider errors, live tool progress, nested-LLM usage telemetry).
  it("maps memory_provider_error", () => {
    const ev = translateCustomEvent("memory_provider_error", {
      provider: "mem0",
      op: "recall",
      error: "TimeoutError: vendor recall timed out",
    });
    expect(ev).toEqual({
      type: "memory_provider_error",
      provider: "mem0",
      op: "recall",
      error: "TimeoutError: vendor recall timed out",
    });
  });

  it("maps tool_progress", () => {
    const ev = translateCustomEvent("tool_progress", {
      call_id: "call-7",
      stream: "progress",
      chunk: "Step 2/5: fetching sources",
    });
    expect(ev).toEqual({
      type: "tool_progress",
      callId: "call-7",
      stream: "progress",
      chunk: "Step 2/5: fetching sources",
      toolName: null,
      item: null,
      index: null,
      total: null,
      data: {
        call_id: "call-7",
        stream: "progress",
        chunk: "Step 2/5: fetching sources",
      },
    });
  });

  // Typing a name that used to fall through to `{type:"custom", name, data}` is a
  // NARROWING unless the payload survives it: before the typed case existed a
  // consumer read the whole dict, so anything the variant does not name becomes
  // unreachable. The payload below is what `web_search` actually emits
  // (backend `src/agent/search_tool.py`) — `tool`, `index`, `total` and the
  // structured `item` are all real keys a consumer could be reading today.
  it("keeps every producer field on tool_progress reachable", () => {
    const ev = translateCustomEvent("tool_progress", {
      tool: "web_search",
      call_id: "call-7",
      stream: "progress",
      index: 0,
      total: 5,
      chunk: "Astralform docs",
      item: { title: "Astralform docs", url: "https://astralform.ai", snippet: "…" },
    });
    expect(ev).toMatchObject({
      type: "tool_progress",
      callId: "call-7",
      toolName: "web_search",
      index: 0,
      total: 5,
      item: { url: "https://astralform.ai" },
    });
  });

  // `generate_video._emit_progress` splats `**extra`, so no fixed field list can
  // be complete — `status` and `preset` are only reachable through `data`.
  it("keeps unnamed tool_progress keys reachable through data", () => {
    const ev = translateCustomEvent("tool_progress", {
      tool: "generate_video",
      call_id: "call-9",
      stream: "progress",
      chunk: "Still generating… 120s elapsed",
      status: "running",
      preset: "720p",
    });
    expect(ev).toMatchObject({
      type: "tool_progress",
      data: { status: "running", preset: "720p" },
    });
  });

  it("maps nested_llm_usage, translating snake_case usage totals to camelCase", () => {
    const ev = translateCustomEvent("nested_llm_usage", {
      source: "deep_research",
      call_id: "call_1",
      input_tokens: 300,
      output_tokens: 30,
      cache_creation_tokens: 7,
      cached_tokens: 11,
      llm_calls: 3,
    });
    expect(ev).toEqual({
      type: "nested_llm_usage",
      source: "deep_research",
      callId: "call_1",
      inputTokens: 300,
      outputTokens: 30,
      cacheCreationTokens: 7,
      cachedTokens: 11,
      llmCalls: 3,
    });
  });

  it("unknown names fall through to generic custom", () => {
    const ev = translateCustomEvent("brand_new_event", { payload: 42 });
    expect(ev).toEqual({
      type: "custom",
      name: "brand_new_event",
      data: { payload: 42 },
    });
  });
});

describe("translateWireEvent", () => {
  it("coerces legacy prompt_suggestion top-level type into a typed event", () => {
    // Backend emits this via writer.emit("prompt_suggestion", {...}),
    // so the wire payload carries type=prompt_suggestion directly rather
    // than being wrapped in a {type: custom, name, data} envelope.
    const wire = {
      type: "prompt_suggestion",
      seq: 7,
      ts: 1_000_000,
      job_id: "job-1",
      suggestions: ["Reboot the thing", "Check the logs"],
    } as unknown as WireEvent;

    const ev = translateWireEvent(wire);
    expect(ev).toEqual({
      type: "prompt_suggestion",
      suggestions: ["Reboot the thing", "Check the logs"],
    });
  });

  it("maps message_stop usage including cache_creation_tokens", () => {
    const wire = {
      type: "message_stop",
      seq: 1,
      ts: 0,
      job_id: "job-1",
      turn_id: "t1",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 20,
        cache_creation_tokens: 5,
      },
      ttfb_ms: 40,
      total_ms: 1000,
      stall_count: 0,
    } as unknown as WireEvent;

    const ev = translateWireEvent(wire);
    expect(ev).toMatchObject({
      type: "message_stop",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        cacheCreationTokens: 5,
      },
    });
  });

  it("keeps memory_provider_error / tool_progress / nested_llm_usage typed through the custom envelope", () => {
    // translateWireEvent forwards backend custom events via translateCustomEvent. These
    // three were falling through to the generic `custom` passthrough, so a consumer had
    // to cast `data`; each must come out as its own typed ChatEvent variant instead.
    const envelopes = [
      {
        type: "custom",
        seq: 1,
        ts: 0,
        job_id: "job-1",
        turn_id: "t1",
        name: "memory_provider_error",
        data: { provider: "supermemory", op: "save", error: "HTTPError: 500" },
      },
      {
        type: "custom",
        seq: 2,
        ts: 0,
        job_id: "job-1",
        turn_id: "t1",
        name: "tool_progress",
        data: { call_id: "call-7", chunk: "compiling" },
      },
      {
        type: "custom",
        seq: 3,
        ts: 0,
        job_id: "job-1",
        turn_id: "t1",
        name: "nested_llm_usage",
        data: {
          source: "deep_research",
          call_id: "call_1",
          input_tokens: 300,
          output_tokens: 30,
          cache_creation_tokens: 7,
          cached_tokens: 11,
          llm_calls: 3,
        },
      },
    ] as unknown as WireEvent[];

    const [memoryEv, progressEv, usageEv] = envelopes.map(translateWireEvent);
    expect(memoryEv).toMatchObject({
      type: "memory_provider_error",
      provider: "supermemory",
      op: "save",
      error: "HTTPError: 500",
    });
    expect(progressEv).toMatchObject({
      type: "tool_progress",
      callId: "call-7",
      stream: "progress",
      chunk: "compiling",
    });
    expect(usageEv).toMatchObject({
      type: "nested_llm_usage",
      source: "deep_research",
      callId: "call_1",
      inputTokens: 300,
      outputTokens: 30,
      cacheCreationTokens: 7,
      cachedTokens: 11,
      llmCalls: 3,
    });
  });

});

describe("the subagent lifecycle frames", () => {
  /**
   * The backend renamed these to `agent_start` / `agent_stop` and flattened the
   * identity onto the payload (`AgentRunStartPayload`: `agent_name`,
   * `agent_display_name`, `agent_avatar_url`), while this translator was
   * written against a NESTED `agent` object on `subagent_*`. So every frame the
   * current backend emits arrived with an EMPTY identity: the events still
   * reached consumers, they just said nothing about which agent was running.
   */
  it("maps the CURRENT wire name, with the flat identity", () => {
    const ev = translateCustomEvent("agent_start", {
      run_id: "run-1",
      parent_call_id: "call-7",
      agent_name: "researcher",
      agent_display_name: "Researcher",
      agent_avatar_url: "https://example.test/a.png",
    });
    expect(ev).toEqual({
      type: "subagent_start",
      runId: "run-1",
      agent: {
        name: "researcher",
        displayName: "Researcher",
        avatarUrl: "https://example.test/a.png",
        description: null,
      },
      taskCallId: "call-7",
    });
  });

  it("still maps the older nested shape", () => {
    const ev = translateCustomEvent("subagent_start", {
      agent: { name: "writer", display_name: "Writer", avatar_url: null },
      task_call_id: "call-9",
    });
    expect(ev).toEqual({
      type: "subagent_start",
      runId: undefined,
      agent: {
        name: "writer",
        displayName: "Writer",
        avatarUrl: null,
        description: null,
      },
      taskCallId: "call-9",
    });
  });

  it("passes the background child's job id through on both frames", () => {
    // Background children are their own job, announced on the parent's stream
    // by the launch/settle path — the client needs the job id to fetch the
    // child's own trajectory for drill-through.
    const start = translateCustomEvent("agent_start", {
      run_id: "job-child-1",
      parent_call_id: "call-7",
      agent_name: "researcher",
      child_job_id: "job-child-1",
    });
    expect(start).toMatchObject({
      type: "subagent_start",
      runId: "job-child-1",
      childJobId: "job-child-1",
    });
    const stop = translateCustomEvent("agent_stop", {
      run_id: "job-child-1",
      stop_reason: "end_turn",
      child_job_id: "job-child-1",
    });
    expect(stop).toMatchObject({
      type: "subagent_stop",
      runId: "job-child-1",
      childJobId: "job-child-1",
    });
  });

  it("carries the child's own spend and outcome on agent_stop", () => {
    // The wire surfaces the child's spend separately from the turn totals
    // (`message_stop.usage` folds them in as well); a consumer that wants to
    // attribute cost to one subagent has no other source.
    const ev = translateCustomEvent("agent_stop", {
      run_id: "run-1",
      parent_call_id: "call-7",
      agent_name: "researcher",
      stop_reason: "end_turn",
      input_tokens: 1200,
      output_tokens: 340,
      duration_ms: 9100,
    });
    expect(ev).toMatchObject({
      type: "subagent_stop",
      runId: "run-1",
      taskCallId: "call-7",
      stopReason: "end_turn",
      inputTokens: 1200,
      outputTokens: 340,
      durationMs: 9100,
    });
  });

  it("degrades to an empty identity rather than a crash on a malformed frame", () => {
    const ev = translateCustomEvent("agent_start", { agent: "not-an-object" });
    expect(ev).toMatchObject({
      type: "subagent_start",
      agent: { name: "", displayName: null, avatarUrl: null, description: null },
      taskCallId: null,
    });
  });
});

describe("the goal progress frame", () => {
  it("maps the full snapshot with snake_case folded", () => {
    const ev = translateCustomEvent("goal_progress", {
      goal_id: "g1",
      conversation_id: "c1",
      objective: "ship it",
      status: "active",
      settled: false,
      continuation_count: 2,
      budget: { max_continuations: 5 },
      usage: { continuations: 2 },
      progress: { done: ["a"] },
      verdict: null,
      blocker: null,
      stop_reason: null,
      availability: {
        pause: { allowed: true },
        resume: { allowed: false, reasonCode: "goalNotPaused" },
      },
    });
    expect(ev).toEqual({
      type: "goal_progress",
      goalId: "g1",
      conversationId: "c1",
      objective: "ship it",
      status: "active",
      settled: false,
      continuationCount: 2,
      budget: { max_continuations: 5 },
      usage: { continuations: 2 },
      progress: { done: ["a"] },
      verdict: null,
      blocker: null,
      stopReason: null,
      budgetExhaustedDimension: null,
      availability: {
        pause: { allowed: true },
        resume: { allowed: false, reasonCode: "goalNotPaused" },
      },
    });
  });

  it("carries the exhausted budget dimension on a budget-limited stand-down", () => {
    // long-horizon phase 2: a goal paused on budget names the dimension that
    // ran out — the field a raise-and-resume affordance moves.
    const ev = translateCustomEvent("goal_progress", {
      goal_id: "g1",
      conversation_id: "c1",
      status: "paused",
      settled: false,
      continuation_count: 3,
      stop_reason: "goal_budget_exhausted",
      budget_exhausted_dimension: "max_tokens",
    });
    expect(ev).toMatchObject({
      type: "goal_progress",
      status: "paused",
      stopReason: "goal_budget_exhausted",
      budgetExhaustedDimension: "max_tokens",
    });
  });

  it("defaults a sparse frame rather than crashing", () => {
    const ev = translateCustomEvent("goal_progress", { goal_id: "g1" });
    expect(ev).toMatchObject({
      type: "goal_progress",
      goalId: "g1",
      status: "unknown",
      settled: false,
      continuationCount: 0,
    });
  });

  it("forwards an unknown future reason code instead of dropping it", () => {
    // The SDK is a transport here, not a policy: whether a code is renderable
    // is the CLIENT's decision (chat keeps the control hidden), and a code
    // this SDK predates must still reach it.
    const ev = translateCustomEvent("goal_progress", {
      goal_id: "g1",
      availability: {
        pause: { allowed: false, reasonCode: "goalScheduledForTomorrow" },
        resume: { allowed: true },
      },
    });
    expect(ev).toMatchObject({
      availability: {
        pause: { allowed: false, reasonCode: "goalScheduledForTomorrow" },
        resume: { allowed: true },
      },
    });
  });

  it("nulls a malformed availability descriptor rather than half-forwarding it", () => {
    // Half a contract cannot be acted on; the client renders no control.
    for (const availability of [
      "paused",
      { pause: { allowed: true } },
      { pause: { allowed: true }, resume: { reasonCode: "goalNotPaused" } },
    ]) {
      const ev = translateCustomEvent("goal_progress", {
        goal_id: "g1",
        availability,
      });
      expect(ev).toMatchObject({ availability: null });
    }
  });
});

describe("the usage snapshot frame", () => {
  it("maps the cumulative in-flight usage frame (long-horizon phase 3)", () => {
    const ev = translateCustomEvent("usage_snapshot", {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: 800,
      elapsed_s: 942.5,
      iteration: 20,
      interrupted_tools: 1,
    });
    expect(ev).toEqual({
      type: "usage_snapshot",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      elapsedS: 942.5,
      iteration: 20,
      interruptedTools: 1,
    });
  });

  it("defaults a sparse frame rather than crashing", () => {
    const ev = translateCustomEvent("usage_snapshot", {});
    expect(ev).toEqual({
      type: "usage_snapshot",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      elapsedS: 0,
      iteration: 0,
      interruptedTools: 0,
    });
  });
});
