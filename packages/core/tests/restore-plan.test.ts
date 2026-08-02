import { describe, it, expect } from "vitest";
import { planRestore } from "../src/restore-plan";

/**
 * Fixtures mirror what the wire actually produces, which is the whole point:
 * an earlier version of these tests invented shapes that never occur and
 * passed against an implementation that was broken in production.
 *
 *  - `jobs.message_id` is NOT NULL, so EVERY job carries a uuid — including
 *    jobs from before prompts were tagged, whose uuid matches nothing.
 *  - `Message.id` is a required string. When a stored row has no id of its own
 *    (every pre-link prompt), the messages endpoint substitutes a positional
 *    index string via `getattr(msg, "id", None) or str(len(result))`.
 *
 * So "has an id" is true of everything and distinguishes nothing. Only whether
 * a job's id MATCHES a message carries information.
 */
const job = (id: string, messageId: string) => ({
  job_id: id,
  message_id: messageId,
});
/** A tagged prompt, or a steer: carries the uuid the backend minted. */
const tagged = (content: string, id: string) => ({ id, content });
/** A pre-link row: the endpoint fabricated a positional index for its id. */
const legacy = (content: string, idx: number) => ({ id: String(idx), content });

describe("planRestore", () => {
  it("pairs each turn with the prompt that started it", () => {
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j2", "m2")],
      userMessages: [tagged("first", "m1"), tagged("second", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "turn", jobId: "j2", content: "second", messageId: "m2" },
    ]);
  });

  it("does not let a steer shift later turns onto the wrong prompt", () => {
    // The bug this exists for. Positionally, j2 takes userMessages[1] — the
    // steer — and "second" never renders at all.
    const steps = planRestore({
      completedJobs: [job("j1", "m1"), job("j2", "m3")],
      userMessages: [
        tagged("first", "m1"),
        tagged("a steer", "m2"),
        tagged("second", "m3"),
      ],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "steer", content: "a steer", messageId: "m2" },
      { kind: "turn", jobId: "j2", content: "second", messageId: "m3" },
    ]);
  });

  it("keeps a steer sent during the last turn, instead of dropping it", () => {
    const steps = planRestore({
      completedJobs: [job("j1", "m1")],
      userMessages: [tagged("first", "m1"), tagged("late steer", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "m1" },
      { kind: "steer", content: "late steer", messageId: "m2" },
    ]);
  });

  it("replays a goal continuation in place, with no bubble of its own", () => {
    // A continuation's seed is hidden from the message list, so its (non-null)
    // message_id matches nothing. It must still replay, between the turns it
    // ran between rather than swept to the end.
    const steps = planRestore({
      completedJobs: [
        job("j1", "m1"),
        job("j1c", "seed-uuid"),
        job("j2", "m2"),
      ],
      userMessages: [tagged("start the goal", "m1"), tagged("next turn", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "start the goal", messageId: "m1" },
      { kind: "turn", jobId: "j1c" },
      { kind: "turn", jobId: "j2", content: "next turn", messageId: "m2" },
    ]);
  });

  it("interleaves a steer sent during a continuation", () => {
    const steps = planRestore({
      completedJobs: [
        job("j1", "m1"),
        job("j1c", "seed-uuid"),
        job("j2", "m3"),
      ],
      userMessages: [
        tagged("goal", "m1"),
        tagged("steer", "m2"),
        tagged("after", "m3"),
      ],
    });
    expect(steps.map((s) => s.kind)).toEqual(["turn", "turn", "steer", "turn"]);
    expect(steps[3]).toEqual({
      kind: "turn",
      jobId: "j2",
      content: "after",
      messageId: "m3",
    });
  });

  it("falls back to position when NO job id matches — every pre-link conversation", () => {
    // The case a presence check gets catastrophically wrong. Both jobs carry a
    // uuid and both messages carry a fabricated index id, so "has an id" is
    // true throughout; only the absence of any MATCH reveals that this
    // conversation predates the tagging. Detecting it by presence renders both
    // turns bubble-less and dumps both prompts at the end as steers.
    const steps = planRestore({
      completedJobs: [job("j1", "old-uuid-1"), job("j2", "old-uuid-2")],
      userMessages: [legacy("first", 0), legacy("second", 2)],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: "first", messageId: "0" },
      { kind: "turn", jobId: "j2", content: "second", messageId: "2" },
    ]);
  });

  it("handles a conversation that spans the change", () => {
    // Tagging began at a point in time, so the split is chronological: the old
    // turn falls back to position, the new one matches exactly.
    const steps = planRestore({
      completedJobs: [job("old", "old-uuid"), job("new", "m2")],
      userMessages: [legacy("legacy prompt", 0), tagged("modern prompt", "m2")],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "old", content: "legacy prompt", messageId: "0" },
      { kind: "turn", jobId: "new", content: "modern prompt", messageId: "m2" },
    ]);
  });

  it("keeps a steer sent after the cutover in a spanning conversation", () => {
    const steps = planRestore({
      completedJobs: [job("old", "old-uuid"), job("new", "m2")],
      userMessages: [
        legacy("legacy prompt", 0),
        tagged("modern prompt", "m2"),
        tagged("steer", "m3"),
      ],
    });
    expect(steps.map((s) => s.kind)).toEqual(["turn", "turn", "steer"]);
  });

  it("returns nothing for an empty conversation", () => {
    expect(planRestore({ completedJobs: [], userMessages: [] })).toEqual([]);
  });

  it("replays a job whose prompt is missing rather than dropping the response", () => {
    // Losing the assistant's answer is worse than losing the bubble above it.
    const steps = planRestore({
      completedJobs: [job("j1", "gone")],
      userMessages: [],
    });
    expect(steps).toEqual([
      { kind: "turn", jobId: "j1", content: undefined, messageId: undefined },
    ]);
  });
});
