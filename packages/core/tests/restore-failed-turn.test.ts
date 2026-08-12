import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import type { StreamManagerEvent } from "../src/stream-manager.js";
import type { ChatEvent } from "../src/types.js";

/**
 * Reopening a conversation whose turn FAILED.
 *
 * The restore fetched events only for jobs with `status === "completed"`, so a
 * failed turn was never asked for and vanished on reload — its tool calls,
 * their output, and the terminal `error` that explains why it stopped. A
 * conversation whose only job failed came back completely blank.
 *
 * Nothing was missing server-side: `job_events` is the forensic record and the
 * history endpoint returns a failed job's stream complete. Only the client
 * declined to read it.
 *
 * Shaped after the incident that found this: one turn, agent generates a video
 * and runs sandbox commands, then compaction outruns the engine's ceiling and
 * the job dies `failed` with "Agent loop timed out".
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The failed turn's persisted events — deltas stripped, as the backend does. */
const FAILED_TURN_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t1", model: "m", job_id: "job-1" },
  },
  {
    seq: 1,
    event: "block_start",
    data: {
      type: "block_start",
      turn_id: "t1",
      job_id: "job-1",
      path: [0],
      kind: "tool_use",
      metadata: { tool_name: "generate_video" },
    },
  },
  {
    seq: 2,
    event: "block_stop",
    data: {
      type: "block_stop",
      turn_id: "t1",
      job_id: "job-1",
      path: [0],
      status: "ok",
      final: { output: "generated-8d205d55.mp4" },
    },
  },
  {
    seq: 3,
    event: "error",
    data: {
      type: "error",
      job_id: "job-1",
      code: "idle_timeout",
      message: "Agent loop timed out",
      block_path: null,
    },
  },
  {
    seq: 4,
    event: "message_stop",
    data: {
      type: "message_stop",
      turn_id: "t1",
      job_id: "job-1",
      stop_reason: "error",
      usage: {},
      total_ms: 778_000,
      stall_count: 5,
    },
  },
];

const MESSAGES = [
  {
    id: "m-1",
    conversation_id: "conv-1",
    role: "user",
    content: "using video chain skill, make a 10s video",
    created_at: "2026-08-12T18:05:05Z",
  },
];

/** The whole conversation: one job, and it failed. */
const FAILED_ONLY_JOBS = [
  { job_id: "job-1", status: "failed", message_id: "m-1" },
];

function setup(jobs: unknown[] = FAILED_ONLY_JOBS) {
  const calls: string[] = [];
  const session = new ChatSession({
    ...baseConfig,
    fetch: async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.includes("/active-job"))
        return json({ job_id: null, status: "none" });
      if (url.includes("/messages")) return json(MESSAGES);
      if (url.includes("/jobs")) return json(jobs);
      if (url.includes("/events")) {
        return json(url.includes("job_id=job-1") ? FAILED_TURN_EVENTS : []);
      }
      return json([]);
    },
  });
  const manager = new StreamManager(session);
  const events: ChatEvent[] = [];
  session.on((e) => events.push(e));
  // `versionsReady` is a MANAGER event, not a session one — the two buses are
  // separate, and listening only to the session makes any assertion about it
  // vacuously "not emitted".
  const managerEvents: StreamManagerEvent[] = [];
  manager.on((e) => managerEvents.push(e));
  return { session, manager, events, managerEvents, calls };
}

const userMessages = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === "user_message")
    .map((e) => (e as Extract<ChatEvent, { type: "user_message" }>).content);

describe("restoring a conversation whose turn failed", () => {
  it("asks for the failed job's events at all", async () => {
    // The root of it: no fetch, no transcript. Asserted on the WIRE rather than
    // on rendered output, because a client that never asks cannot be rescued by
    // anything downstream.
    const { manager, calls } = setup();

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("job_id=job-1"))).toBe(true);
  });

  it("replays the work the agent did before it died", async () => {
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    const toolBlocks = events.filter(
      (e) => e.type === "block_start" && e.kind === "tool_use",
    );
    expect(toolBlocks).toHaveLength(1);
  });

  it("replays the error that explains why it stopped", async () => {
    // The single most useful event in a failed turn, and the one a
    // completed-only filter is guaranteed to drop: a job carrying a terminal
    // error is by definition not completed.
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Extract<ChatEvent, { type: "error" }>).message).toBe(
      "Agent loop timed out",
    );
  });

  it("renders the prompt exactly once", async () => {
    // Not a test of the claim set — a failed job now anchors its own prompt and
    // `planRestore` advances past an anchored index, so the steer branch never
    // sees it either way. This pins the OUTCOME the user reads: one bubble, not
    // the doubled one that a widened replay set is the obvious way to cause.
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    expect(userMessages(events)).toEqual([
      "using video chain skill, make a 10s video",
    ]);
  });

  it("offers no version to navigate to", async () => {
    // Wider replay is about showing what happened; versions are about answers
    // the user can switch between. A failed turn produced none.
    const { manager, managerEvents } = setup();

    await manager.switchTo("conv-1");

    expect(managerEvents.some((e) => e.type === "versionsReady")).toBe(false);
  });

  it("still counts the completed turns when a conversation has both", async () => {
    const { manager, managerEvents } = setup([
      { job_id: "job-0", status: "completed", message_id: "m-0" },
      { job_id: "job-1", status: "failed", message_id: "m-1" },
    ]);

    await manager.switchTo("conv-1");

    const ready = managerEvents.find((e) => e.type === "versionsReady");
    expect(ready).toBeDefined();
    expect((ready as Extract<StreamManagerEvent, { type: "versionsReady" }>).count).toBe(1);
  });
});
