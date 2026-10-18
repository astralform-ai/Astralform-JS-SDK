import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import type { ChatEvent } from "../src/types.js";

/**
 * Reopening a conversation that has background-subagent children.
 *
 * Children are jobs (`parent_job_id` set, `message_id` null): their whole
 * turns used to replay into the parent transcript alongside the parent's —
 * headless turns with no prompt bubble, each contributing its own blocks AND
 * its own error blocks. One `idle_timeout` on a failed child rendered twice:
 * once for the child's turn, once for the parent's.
 *
 * Live they never do (children only announce `agent_start`/`agent_stop` onto
 * the parent stream; their blocks render under the spawn block). Restore must
 * match: jobs with a `parent_job_id` are excluded from the replay walk AND
 * never fetched.
 *
 * Shaped after conv 6a7635b0: parent `job-1` failed with idle_timeout, child
 * `child-1` failed with idle_timeout, sibling `child-2` completed — reload
 * rendered two identical quiet-stop banners.
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

const PARENT_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t1", model: "m", job_id: "job-1" },
  },
  {
    seq: 1,
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
    seq: 2,
    event: "message_stop",
    data: {
      type: "message_stop",
      turn_id: "t1",
      job_id: "job-1",
      stop_reason: "error",
      usage: {},
      total_ms: 1000,
      stall_count: 0,
    },
  },
];

const CHILD_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t2", model: "m", job_id: "child-1" },
  },
  {
    seq: 1,
    event: "error",
    data: {
      type: "error",
      job_id: "child-1",
      code: "idle_timeout",
      message: "Agent loop timed out",
      block_path: null,
    },
  },
  {
    seq: 2,
    event: "message_stop",
    data: {
      type: "message_stop",
      turn_id: "t2",
      job_id: "child-1",
      stop_reason: "error",
      usage: {},
      total_ms: 1000,
      stall_count: 0,
    },
  },
];

const MESSAGES = [
  {
    id: "m-1",
    conversation_id: "conv-1",
    role: "user",
    content: "build the thing",
    created_at: "2026-10-18T00:00:00Z",
  },
];

const JOBS_WITH_CHILDREN = [
  { job_id: "job-1", status: "failed", message_id: "m-1", parent_job_id: null },
  { job_id: "child-1", status: "failed", message_id: null, parent_job_id: "job-1" },
  { job_id: "child-2", status: "completed", message_id: null, parent_job_id: "job-1" },
];

function setup(jobs: unknown[] = JOBS_WITH_CHILDREN) {
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
        if (url.includes("job_id=job-1")) return json(PARENT_EVENTS);
        if (url.includes("job_id=child-1")) return json(CHILD_EVENTS);
        return json([]);
      }
      return json([]);
    },
  });
  const manager = new StreamManager(session);
  const events: ChatEvent[] = [];
  session.on((e) => events.push(e));
  return { session, manager, events, calls };
}

describe("restoring a conversation with background children", () => {
  it("never fetches a child's events", async () => {
    // The root of it: no fetch, no headless turn. Asserted on the WIRE —
    // a client that never asks cannot render the child's blocks.
    const { manager, calls } = setup();

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("job_id=job-1"))).toBe(true);
    expect(calls.some((u) => u.includes("job_id=child-1"))).toBe(false);
    expect(calls.some((u) => u.includes("job_id=child-2"))).toBe(false);
  });

  it("replays exactly one error — the parent's, not the child's", async () => {
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(
      (errors[0] as Extract<ChatEvent, { type: "error" }>).message,
    ).toContain("Agent loop timed out");
  });

  it("still replays children from servers that predate parent_job_id", async () => {
    // Absent field = old backend: every job replays as before (the old
    // behaviour, double banner included — the projection is what fixes it).
    const legacy = JOBS_WITH_CHILDREN.map(({ parent_job_id: _, ...j }) => j);
    const { manager, calls } = setup(legacy);

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("job_id=child-1"))).toBe(true);
  });
});
