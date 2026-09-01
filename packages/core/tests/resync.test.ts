import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import type { ChatEvent } from "../src/types.js";

/**
 * `resync` — re-attaching to a live turn after the page sat in the background.
 *
 * The reconnect loop inside `consumeEventStream` only runs while a stream is
 * being consumed. A page suspended in the background can outlive it: timers
 * throttled so the stall watchdog never fires, the reconnect budget burned in
 * fail-fast attempts, a rotated token's 401 ending the loop as non-retryable.
 * What's left is a manager that either still believes a turn is streaming
 * (zombie belief, nothing attached) or has given up on one that is still
 * running server-side — and no navigation fixes either, because `switchTo`
 * early-returns on the conversation it is already on. That is Astralform
 * issue #1012: "returning to chat while it is still running server-side does
 * not bring back the in-progress conversation".
 *
 * These drive the manager against the same backend shapes as
 * `restore-live-turn.test.ts` (one completed turn, one running turn) and
 * assert `resync` rebuilds from server truth — or provably doesn't touch a
 * healthy/idle session.
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function sse(body: string): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function ev(name: string, obj: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}

const DONE_TURN_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t1", model: "m", job_id: "job-1" },
  },
  {
    seq: 1,
    event: "block_stop",
    data: {
      type: "block_stop",
      turn_id: "t1",
      job_id: "job-1",
      path: [0],
      status: "ok",
      final: { text: "Here is a teapot." },
    },
  },
  {
    seq: 2,
    event: "message_stop",
    data: {
      type: "message_stop",
      turn_id: "t1",
      job_id: "job-1",
      stop_reason: "end_turn",
      usage: {},
      total_ms: 10,
      stall_count: 0,
    },
  },
];

/** job-2's persisted events, for the "it finished while we were away" case. */
const FINISHED_LIVE_TURN_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t2", model: "m", job_id: "job-2" },
  },
  {
    seq: 1,
    event: "block_stop",
    data: {
      type: "block_stop",
      turn_id: "t2",
      job_id: "job-2",
      path: [0],
      status: "ok",
      final: { text: "The video rendered." },
    },
  },
  {
    seq: 2,
    event: "message_stop",
    data: {
      type: "message_stop",
      turn_id: "t2",
      job_id: "job-2",
      stop_reason: "end_turn",
      usage: {},
      total_ms: 10,
      stall_count: 0,
    },
  },
];

const LIVE_STREAM =
  ev("message_start", {
    type: "message_start",
    turn_id: "t2",
    model: "m",
    job_id: "job-2",
    seq: 1,
    ts: 0,
  }) +
  ev("message_stop", {
    type: "message_stop",
    turn_id: "t2",
    job_id: "job-2",
    stop_reason: "end_turn",
    usage: {},
    total_ms: 10,
    stall_count: 0,
    seq: 9,
    ts: 0,
  }) +
  "data: [DONE]\n\n";

const MESSAGES = [
  {
    id: "m-1",
    conversation_id: "conv-1",
    role: "user",
    content: "draw me a teapot",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "m-2",
    conversation_id: "conv-1",
    role: "user",
    content: "now generate a video of it",
    created_at: "2026-01-01T00:01:00Z",
  },
];

const JOBS = [
  { job_id: "job-1", status: "completed", message_id: "m-1" },
  { job_id: "job-2", status: "running", message_id: "m-2" },
];

interface BackendState {
  /** What `/active-job` answers; null = nothing live. */
  liveJobId: string | null;
  /** Whether the job list reports job-2 completed (it finished while away). */
  job2Finished?: boolean;
}

/**
 * Records every URL fetched and answers from mutable `state`, so a test can
 * flip server truth between the initial switch and the resync — the whole
 * point being that the resync re-asks rather than trusting local state.
 */
function mockBackend(calls: string[], state: BackendState) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.includes("/active-job")) {
      return json({
        job_id: state.liveJobId,
        status: state.liveJobId ? "running" : "none",
      });
    }
    if (url.includes("/v1/jobs/")) return sse(LIVE_STREAM);
    if (url.includes("/messages")) return json(MESSAGES);
    if (url.includes("/jobs")) {
      return json(
        state.job2Finished
          ? [
              { job_id: "job-1", status: "completed", message_id: "m-1" },
              { job_id: "job-2", status: "completed", message_id: "m-2" },
            ]
          : JOBS,
      );
    }
    if (url.includes("/events")) {
      if (url.includes("job_id=job-1")) return json(DONE_TURN_EVENTS);
      if (url.includes("job_id=job-2")) {
        return json(state.job2Finished ? FINISHED_LIVE_TURN_EVENTS : []);
      }
      return json([]);
    }
    return json([]);
  };
}

function setup(state: BackendState) {
  const calls: string[] = [];
  const session = new ChatSession({
    ...baseConfig,
    fetch: mockBackend(calls, state),
  });
  const manager = new StreamManager(session);
  const events: ChatEvent[] = [];
  session.on((e) => events.push(e));
  const managerEvents: { type: string; state?: string }[] = [];
  manager.on((e) => {
    if (e.type === "stateChange") managerEvents.push({ type: e.type, state: e.state });
  });
  return { session, manager, events, calls, managerEvents };
}

/** Open conv-1 the ordinary way; leaves manager idle (the SSE is terminal). */
async function openConversation() {
  const state: BackendState = { liveJobId: "job-2" };
  const ctx = setup(state);
  await ctx.manager.switchTo("conv-1");
  return { ...ctx, state };
}

const userMessages = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === "user_message")
    .map((e) => (e as Extract<ChatEvent, { type: "user_message" }>).content);

describe("resync: the stream died in the background and the job is still live", () => {
  it("re-attaches through the full restore path", async () => {
    // The #1012 shape: the reconnect budget exhausted while hidden (or a
    // rotated token's 401 ended it), so the manager is idle with nothing
    // attached — while the server still reports the job running. No
    // navigation follows the user's return, so only resync can fix it.
    const { manager, events, calls } = await openConversation();
    const before = calls.length;
    events.length = 0;

    await manager.resync();

    // The restore ran end to end: history replay …
    expect(userMessages(events)).toEqual([
      "draw me a teapot",
      "now generate a video of it",
    ]);
    // … and a fresh connection to the live job's stream.
    const after = calls.slice(before);
    expect(after.some((u) => u.includes("/v1/jobs/job-2/events"))).toBe(true);
    // The running job's events are still NOT fetched from history — the live
    // stream owns them, exactly as on the original open.
    expect(after.some((u) => u.includes("job_id=job-2"))).toBe(false);
  });

  it("clears the zombie-belief state even when the job already finished", async () => {
    // The mirror case: the manager still believes a turn is streaming
    // (`_state` never left "streaming" because the socket died without a
    // terminal and the watchdog never fired), but the job finished while the
    // page was suspended. The resync must replay the missed tail and settle
    // idle — not leave the belief standing.
    const { manager, events, managerEvents, state } = await openConversation();
    // The job finished while we were away: nothing live, its row completed.
    state.liveJobId = null;
    state.job2Finished = true;
    events.length = 0;
    managerEvents.length = 0;
    (
      manager as unknown as { _state: string }
    )._state = "streaming"; // the zombie belief — normally set by `send`

    await manager.resync();

    // The turn that finished while away renders from history …
    const finished = events.find(
      (e) => e.type === "block_stop" && e.turnId === "t2",
    );
    expect(finished).toBeDefined();
    // … the restore was announced (consumers cleared on it) …
    expect(managerEvents).toContainEqual({ type: "stateChange", state: "restoring" });
    // … and the manager settled rather than staying on the stale streaming
    // belief.
    expect(manager.state).toBe("idle");
  });
});

describe("resync: the states that must cost nothing", () => {
  it("does not touch a healthy attachment", async () => {
    // Attached to exactly the job the server calls live: the stall watchdog
    // owns zombie recovery from here, so the resync must not tear a working
    // stream down — on every focus event, that would be thrash.
    const { manager, calls } = await openConversation();
    // Simulate the live attachment: mid-turn, connected to job-2.
    (
      manager as unknown as { _state: string }
    )._state = "streaming";
    const session = (
      manager as unknown as { session: ChatSession }
    ).session;
    (session as unknown as { isStreaming: boolean }).isStreaming = true;
    (session as unknown as { currentJobId: string | null }).currentJobId = "job-2";

    const before = calls.length;
    await manager.resync();

    expect(calls.length - before).toBe(1); // the probe, and nothing else
    expect(manager.state).toBe("streaming");
  });

  it("does nothing when idle with no live job", async () => {
    // The ordinary focus event: no turn attached, nothing running. One probe
    // and out — no history replay, no SSE connection.
    const { manager, calls } = await (async () => {
      const s = setup({ liveJobId: null });
      await s.manager.switchTo("conv-1");
      return s;
    })();

    const before = calls.length;
    await manager.resync();
    expect(calls.length - before).toBe(1); // probe only
    expect(manager.state).toBe("idle");
  });

  it("skips while a restore is already in flight", async () => {
    // A restore is converging on server truth by itself; a resync landing
    // on top of it would detach the stream it is about to open.
    const { manager, calls } = await openConversation();
    (
      manager as unknown as { _state: string }
    )._state = "restoring";

    const before = calls.length;
    await manager.resync();

    expect(calls.length - before).toBe(0); // not even the probe
  });
});

describe("resync: re-entrancy", () => {
  it("a second resync during the first's probe does nothing", async () => {
    // visibilitychange and focus can both fire for one return. The second
    // call must find `_resyncing` set and leave the first to converge.
    let openProbe!: () => void;
    let gateArmed = false;
    const probeGate = new Promise<void>((r) => {
      openProbe = r;
    });
    const state: BackendState = { liveJobId: "job-2" };
    const calls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        calls.push(url);
        if (url.includes("/active-job") && gateArmed) {
          await probeGate;
          return json({ job_id: state.liveJobId, status: "running" });
        }
        return mockBackend([], state)(input);
      },
    });
    const manager = new StreamManager(session);
    await manager.switchTo("conv-1");

    // Arm the gate AFTER the open completes, so only the resync's probe parks.
    gateArmed = true;
    const first = manager.resync();
    await new Promise((r) => setTimeout(r, 0));
    const probedSoFar = calls.filter((u) => u.includes("/active-job")).length;
    await manager.resync(); // must return without probing
    expect(calls.filter((u) => u.includes("/active-job")).length).toBe(probedSoFar);

    openProbe();
    await first;
  });
});
