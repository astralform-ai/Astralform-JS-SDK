import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import type { ChatEvent } from "../src/types.js";

/**
 * Reopening a conversation whose turn is still RUNNING.
 *
 * The restore used to split on this: a settled conversation replayed its
 * history, and a live one skipped straight to the running job's SSE stream. But
 * a prompt is not in `job_events` — it lives in the messages table — and
 * neither is any earlier turn, so a conversation reopened mid-turn rendered the
 * running turn's blocks under nothing at all: no prompt, no history. A tool
 * call that runs for minutes (video generation) made that window wide enough to
 * hit by simply switching conversations and back.
 *
 * These drive the manager against a backend with one completed turn and one
 * running turn, and assert the transcript is whole.
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

/** The completed turn's persisted events (deltas stripped, as the backend does). */
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

/**
 * What the RUNNING job's stream has emitted so far: the turn opened and a
 * long-running tool block started. This is the whole of what the old code
 * rendered — the lone "Generate Video" pill from the bug report.
 */
const LIVE_STREAM =
  ev("message_start", {
    type: "message_start",
    turn_id: "t2",
    model: "m",
    job_id: "job-2",
    seq: 1,
    ts: 0,
  }) +
  ev("block_start", {
    type: "block_start",
    turn_id: "t2",
    job_id: "job-2",
    path: [0],
    kind: "tool_use",
    metadata: { tool_name: "generate_video" },
    seq: 5,
    ts: 0,
  }) +
  // The turn then finishes. Only so the mocked stream terminates and
  // `switchTo` resolves — a real generation sits open on the tool block for
  // minutes, which is the window this whole file is about. Nothing below
  // depends on the turn having ended; the assertions are all about what the
  // restore emitted BEFORE the reconnect.
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

/** Records every URL fetched, so "was this endpoint hit?" is assertable. */
function mockBackend(calls: string[]): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push(url);

    if (url.includes("/active-job")) {
      return json({ job_id: "job-2", status: "running" });
    }
    // The RUNNING job's live stream (`/v1/jobs/{id}/events`), which is a
    // different endpoint from the per-turn history fetch below.
    if (url.includes("/v1/jobs/")) return sse(LIVE_STREAM);
    if (url.includes("/messages")) return json(MESSAGES);
    if (url.includes("/jobs")) return json(JOBS);
    if (url.includes("/events")) {
      return json(url.includes("job_id=job-1") ? DONE_TURN_EVENTS : []);
    }
    return json([]);
  };
}

function setup() {
  const calls: string[] = [];
  const session = new ChatSession({
    ...baseConfig,
    fetch: mockBackend(calls),
  });
  const manager = new StreamManager(session);
  const events: ChatEvent[] = [];
  session.on((e) => events.push(e));
  return { session, manager, events, calls };
}

const userMessages = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === "user_message")
    .map((e) => (e as Extract<ChatEvent, { type: "user_message" }>).content);

describe("restoring a conversation whose turn is still running", () => {
  it("emits the running turn's prompt, not just its blocks", async () => {
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    expect(userMessages(events)).toContain("now generate a video of it");
  });

  it("puts that prompt BEFORE the live stream's message_start", async () => {
    // Ordering is the half that a naive fix gets wrong: emitted after the
    // reconnect, the bubble lands under the agent header the live
    // `message_start` already opened, which is the same mis-ordering the
    // memory-recall chip hit.
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    const promptIdx = events.findIndex(
      (e) =>
        e.type === "user_message" && e.content === "now generate a video of it",
    );
    const liveStartIdx = events.findIndex(
      (e) => e.type === "message_start" && e.turnId === "t2",
    );

    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(liveStartIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeLessThan(liveStartIdx);
  });

  it("replays the earlier completed turns too", async () => {
    // The running turn is not the only casualty: the whole transcript above it
    // was missing for as long as the turn lasted.
    const { manager, events } = setup();

    await manager.switchTo("conv-1");

    expect(userMessages(events)).toEqual([
      "draw me a teapot",
      "now generate a video of it",
    ]);
    const replayed = events.some(
      (e) => e.type === "block_stop" && e.turnId === "t1",
    );
    expect(replayed).toBe(true);
  });

  it("does not fetch the running job's events from history", async () => {
    // They arrive on the live stream; fetching them here would replay every
    // block the reconnect is about to deliver a second time.
    const { manager, calls } = setup();

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("job_id=job-2"))).toBe(false);
    // ...while the completed turn's events ARE fetched.
    expect(calls.some((u) => u.includes("job_id=job-1"))).toBe(true);
  });

  it("still reconnects to the live stream", async () => {
    const { manager, events, calls } = setup();

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("/v1/jobs/job-2/events"))).toBe(true);
    const pill = events.find(
      (e) => e.type === "block_start" && e.turnId === "t2",
    );
    expect(pill).toBeDefined();
  });

  it("does not replay history over a turn the consumer is already rendering", async () => {
    // A `send` landing inside the active-job probe leaves the session
    // streaming, so `restoring` is never announced and the consumer never
    // clears — it still holds the prompt bubble it inserted optimistically.
    // Replaying on top of that duplicates the transcript instead of
    // repainting it.
    const { session, manager, events } = setup();
    (session as unknown as { isStreaming: boolean }).isStreaming = true;

    await manager.switchTo("conv-1");

    expect(userMessages(events)).toEqual([]);
  });
});

describe("the probe and the job list can disagree", () => {
  /**
   * `getActiveJob` and `GET /jobs` are two awaits apart — `loadConversation`
   * sits between them — so a turn that ENDS in that window is reported running
   * by the probe and completed by the list. Naming it in both put the same job
   * in `completedJobs` and `runningJob`, which the plan walked twice.
   */
  function racingBackend(calls: string[]): typeof globalThis.fetch {
    return async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.includes("/active-job")) {
        return json({ job_id: "job-2", status: "running" });
      }
      if (url.includes("/v1/jobs/")) return sse(LIVE_STREAM);
      if (url.includes("/messages")) return json(MESSAGES);
      // The list, fetched later, has already caught up: job-2 is done.
      if (url.includes("/jobs")) {
        return json([
          { job_id: "job-1", status: "completed", message_id: "m-1" },
          { job_id: "job-2", status: "completed", message_id: "m-2" },
        ]);
      }
      if (url.includes("/events")) {
        return json(url.includes("job_id=job-1") ? DONE_TURN_EVENTS : []);
      }
      return json([]);
    };
  }

  it("renders the raced turn's prompt exactly once", async () => {
    const calls: string[] = [];
    const session = new ChatSession({ ...baseConfig, fetch: racingBackend(calls) });
    const manager = new StreamManager(session);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await manager.switchTo("conv-1");

    expect(userMessages(events)).toEqual([
      "draw me a teapot",
      "now generate a video of it",
    ]);
  });

  it("keeps the raced turn out of the history events wave", async () => {
    // Its events arrive on the reconnect, which drains the whole log of a job
    // that has just finished — so fetching them here would render them twice.
    const calls: string[] = [];
    const session = new ChatSession({ ...baseConfig, fetch: racingBackend(calls) });
    const manager = new StreamManager(session);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await manager.switchTo("conv-1");

    expect(calls.some((u) => u.includes("job_id=job-2"))).toBe(false);
    expect(
      events.filter((e) => e.type === "message_start" && e.turnId === "t2"),
    ).toHaveLength(1);
  });
});

describe("a send landing inside the probe window", () => {
  it("is not replayed over", async () => {
    // `send` bails only on `streaming` and restore sits in `restoring`, so a
    // send during the active-job probe goes through: it clears nothing and
    // renders its own optimistic prompt. Replaying the history on top of that
    // re-emits the prompt and appends the transcript under the live turn.
    // The entry-time flag says "we cleared"; only the CURRENT streaming state
    // says "something took the view over since".
    const session = new ChatSession({ ...baseConfig, fetch: mockBackend([]) });
    const manager = new StreamManager(session);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    // The send lands while the probe is in flight: streaming goes true after
    // `announcedRestoring` was captured false.
    const switching = manager.switchTo("conv-1");
    (session as unknown as { isStreaming: boolean }).isStreaming = true;
    await switching;

    expect(userMessages(events)).toEqual([]);
  });
});
