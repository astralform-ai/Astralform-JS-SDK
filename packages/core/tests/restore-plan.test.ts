import { describe, it, expect } from "vitest";
import { planRestore } from "../src/restore-plan";

const job = (id: string, messageId?: string | null) => ({
  job_id: id,
  message_id: messageId ?? null,
});
const msg = (content: string, id?: string) =>
  id ? { id, content } : { content };

describe("planRestore", () => {
  it("pairs each turn with the prompt that started it", () => {
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j2", "m2")],
      userMessages: [msg("first", "m1"), msg("second", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "turn", jobId: "j2", content: "second", messageId: "m2" },
    ]);
  });

  it("does not let a steer shift later turns onto the wrong prompt", () => {
    // The bug this exists for. Positionally, job j2 would take userMessages[1]
    // — the steer — and "second" would never render at all.
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j2", "m3")],
      userMessages: [
        msg("first", "m1"),
        msg("a steer", "m2"),
        msg("second", "m3"),
      ],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "steer", content: "a steer", messageId: "m2" },
      { kind: "turn", jobId: "j2", content: "second", messageId: "m3" },
    ]);
  });

  it("keeps a steer sent during the last turn, instead of dropping it", () => {
    // Positionally this one fell off the end of the loop and vanished — the
    // symptom that survived even after the pending-steer notice shipped.
    const steps = planRestore({
      completedJobs: [job("j1", "m1")],
      userMessages: [msg("first", "m1"), msg("late steer", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "steer", content: "late steer", messageId: "m2" },
    ]);
  });

  it("replays a goal continuation in place, with no bubble of its own", () => {
    // Continuation seeds are hidden from the message list, so the job matches
    // nothing. It must still replay its events, and must stay between the turns
    // it ran between — not get swept to the end.
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j1c", "m-seed"), job("j2", "m2")],
      userMessages: [msg("start the goal", "m1"), msg("next turn", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "start the goal", messageId: "m1" },
      { kind: "turn", jobId: "j1c" },
      { kind: "turn", jobId: "j2", content: "next turn", messageId: "m2" },
    ]);
  });

  it("interleaves a steer sent during a continuation", () => {
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j1c", "m-seed"), job("j2", "m3")],
      userMessages: [msg("goal", "m1"), msg("steer", "m2"), msg("after", "m3")],
    });
    expect(steps.map((s) => s.kind)).toEqual(["turn", "turn", "steer", "turn"]);
    expect(steps[3]).toEqual({
      kind: "turn",
      jobId: "j2",
      content: "after",
      messageId: "m3",
    });
  });

  it("falls back to positional pairing for a conversation with no links", () => {
    // Pre-link data: no job carries a message_id and no backfill is possible.
    // Keeping the old walk preserves the prompts; the alternative is every
    // bubble disappearing from historic conversations.
    const steps = planRestore({
      completedJobs: [job("j1"), job("j2")],
      userMessages: [msg("first"), msg("second")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: undefined },
      { kind: "turn", jobId: "j2", content: "second", messageId: undefined },
    ]);
  });

  it("handles a conversation that spans the change", () => {
    // An old turn (no ids either side) followed by a new one. The old job takes
    // the id-less message; the new job matches by id.
    const steps = planRestore({
      completedJobs: [job("old"), job("new", "m2")],
      userMessages: [msg("legacy prompt"), msg("modern prompt", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "old", content: "legacy prompt" },
      { kind: "turn", jobId: "new", content: "modern prompt", messageId: "m2" },
    ]);
  });

  it("returns nothing for an empty conversation", () => {
    expect(planRestore({ completedJobs: [], userMessages: [] })).toEqual([]);
  });

  it("replays a job whose prompt is missing rather than dropping the response", () => {
    // Shouldn't happen, but losing the assistant's answer is worse than losing
    // the bubble above it.
    const steps = planRestore({
      completedJobs: [job("j1", "gone")],
      userMessages: [],
    });
    expect(steps).toEqual([{ kind: "turn", jobId: "j1" }]);
  });
});
