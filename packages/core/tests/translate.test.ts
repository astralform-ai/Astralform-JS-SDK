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

  it("maps prompt_suggestion via custom envelope", () => {
    const ev = translateCustomEvent("prompt_suggestion", {
      suggestions: ["Try X", "Ask about Y"],
    });
    expect(ev).toEqual({
      type: "prompt_suggestion",
      suggestions: ["Try X", "Ask about Y"],
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
});
