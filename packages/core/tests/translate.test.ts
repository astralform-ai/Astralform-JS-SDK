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

  it("maps tool_permission_denied with reason and denied_by", () => {
    const ev = translateCustomEvent("tool_permission_denied", {
      tool_name: "rm",
      call_id: "call-9",
      reason: "Matched dangerous pattern",
      denied_by: "rule",
    });
    expect(ev).toEqual({
      type: "tool_permission_denied",
      toolName: "rm",
      callId: "call-9",
      reason: "Matched dangerous pattern",
      deniedBy: "rule",
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
      tool: null,
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
      tool: "web_search",
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
