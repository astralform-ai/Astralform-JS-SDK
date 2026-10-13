import { describe, it, expect, vi } from "vitest";
import { ChatSession } from "../src/session.js";
import type { ChatEvent } from "../src/types.js";

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

// initial connection + SSE_MAX_RECONNECTS (6) in session.ts
const MAX_EVENTS_CALLS = 7;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(body: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(body));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function ev(name: string, obj: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
}
const DONE = "data: [DONE]\n\n";

const msgStart = (seq: number) =>
  ev("message_start", {
    type: "message_start",
    turn_id: "t1",
    model: "m",
    agent_display_name: "A",
    job_id: "job-1",
    seq,
    ts: 0,
  });
const blockStart = (seq: number) =>
  ev("block_start", {
    type: "block_start",
    turn_id: "t1",
    job_id: "job-1",
    path: [0],
    kind: "text",
    metadata: {},
    seq,
    ts: 0,
  });
const blockDelta = (seq: number, text: string) =>
  ev("block_delta", {
    type: "block_delta",
    turn_id: "t1",
    job_id: "job-1",
    path: [0],
    delta: { channel: "text", text },
    seq,
    ts: 0,
  });
const msgStop = (seq: number) =>
  ev("message_stop", {
    type: "message_stop",
    turn_id: "t1",
    job_id: "job-1",
    stop_reason: "end_turn",
    usage: {},
    total_ms: 100,
    seq,
    ts: 0,
  });
const errorEv = (seq: number, code: string) =>
  ev("error", {
    type: "error",
    job_id: "job-1",
    code,
    message: "boom",
    seq,
    ts: 0,
  });

/** Mock fetch that serves successive SSE bodies for /events and records URLs. */
function reconnectFetch(
  eventsBodies: string[],
  urlSink?: string[],
): typeof globalThis.fetch {
  let call = 0;
  return (async (input: unknown, init?: { method?: string }) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/events")) {
      const i = call++;
      urlSink?.push(url);
      return sseResponse(eventsBodies[Math.min(i, eventsBodies.length - 1)]);
    }
    if (url.includes("/v1/jobs") && init?.method === "POST") {
      return jsonResponse(
        {
          job_id: "job-1",
          conversation_id: "c1",
          message_id: "m1",
          status: "queued",
        },
        201,
      );
    }
    if (url.includes("/v1/agent/status")) {
      return jsonResponse({
        is_ready: true,
        llm_configured: true,
        message: "Ready",
      });
    }
    return jsonResponse([]); // conversations, agents, skills
  }) as unknown as typeof globalThis.fetch;
}

describe("ChatSession auto-reconnect", () => {
  it("resumes from lastSeq when the stream drops without a terminal event", async () => {
    const partial = msgStart(0) + blockStart(1) + blockDelta(2, "Hi"); // no message_stop
    const terminal = msgStop(3) + DONE;
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial, terminal], urls),
    });
    await session.connect();
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(urls).toHaveLength(2); // exactly one reconnect
    expect(urls[1]).toContain("after=2"); // resumed from the last seq before the drop
  });

  it("does not let a keepalive reset the resume point", async () => {
    // The backend's keepalive is a normal `data:` frame and carries `seq: 0`
    // (`src/stream/protocol.py`: `WireKeepalive(seq=0, ts=0.0)`) — it is an
    // idle tick, not an event. It arrives exactly when a turn is quiet for 45 s,
    // which is the LONG TOOL RUN case, and the harvest that feeds `?after=`
    // took any numeric `seq` it saw: one keepalive and the resume point fell
    // back to 0, so the next reconnect replayed the whole turn (deltas and
    // all) over blocks the consumer was already rendering.
    const keepalive = ev("keepalive", {
      type: "keepalive",
      job_id: "job-1",
      seq: 0,
      ts: 0,
      since_last_event_ms: 45000,
    });
    const partial = msgStart(0) + blockStart(1) + blockDelta(2, "Hi") + keepalive;
    const terminal = msgStop(3) + DONE;
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial, terminal], urls),
    });
    await session.connect();
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(urls).toHaveLength(2);
    // 2 = the last real event, NOT the keepalive's 0.
    expect(urls[1]).toContain("after=2");
  });

  it("never rewinds the resume point on a frame with an older seq", async () => {
    // The second half of the rule: the cursor only ADVANCES. A frame that
    // carries an older position (a re-delivered row, a future frame with a
    // sentinel seq) must not move it back — the failure mode is the same
    // whole-turn replay the keepalive case has.
    const stale = blockDelta(1, "old");
    const partial = msgStart(0) + blockStart(1) + blockDelta(2, "Hi") + stale;
    const terminal = msgStop(3) + DONE;
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial, terminal], urls),
    });
    await session.connect();
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("after=2");
  });

  it("stops reconnecting once the backend back-fills a terminal error", async () => {
    const partial = msgStart(0) + blockStart(1); // no terminal
    const backfill = errorEv(2, "stream_interrupted") + DONE; // backend #229 back-fill
    const urls: string[] = [];
    const events: ChatEvent[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial, backfill], urls),
    });
    await session.connect();
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(
      events.some((e) => e.type === "error" && e.code === "stream_interrupted"),
    ).toBe(true);
    expect(urls).toHaveLength(2); // reconnected once, then the terminal stops it
  });

  it("does not reconnect when the stream completes normally", async () => {
    const full =
      msgStart(0) + blockStart(1) + blockDelta(2, "Hi") + msgStop(3) + DONE;
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([full], urls),
    });
    await session.connect();
    await session.send("Hi");

    expect(urls).toHaveLength(1); // single connection, no reconnect
  });

  it("treats the transport done sentinel as terminal — a finished run replayed without message_stop does not storm", async () => {
    // The backend ends every subscription with the sentinel frame (`event: done`,
    // `data: {"seq":N,"data":"[DONE]"}`), and a job that already finished —
    // completed or cancelled — replays with it as the ONLY terminal. It used to
    // be consumed silently, so the stream looked dropped: six backoff sleeps, a
    // `connection_error` banner over a finished run, and the conversation left
    // marked running.
    const replayed =
      msgStart(0) +
      blockStart(1) +
      blockDelta(2, "Hi") +
      ev("done", { seq: 3, data: "[DONE]" });
    const urls: string[] = [];
    const events: ChatEvent[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([replayed], urls),
    });
    await session.connect();
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();

    expect(urls).toHaveLength(1); // the sentinel ended it — no reconnect ladder
    expect(events.some((e) => e.type === "error")).toBe(false); // and no invented failure
  });

  it("gives up with a connection error after exhausting reconnects (never loops forever)", async () => {
    const partial = msgStart(0) + blockStart(1); // never terminal
    const urls: string[] = [];
    const events: ChatEvent[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial], urls),
    });
    await session.connect();
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    vi.useRealTimers();

    expect(
      events.some((e) => e.type === "error" && e.code === "connection_error"),
    ).toBe(true);
    expect(urls).toHaveLength(MAX_EVENTS_CALLS); // initial + 6 reconnects, then stop
  });

  it("surfaces an auth error immediately without retrying", async () => {
    const urls: string[] = [];
    const fetch = (async (input: unknown, init?: { method?: string }) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("/events")) {
        urls.push(url);
        return new Response("unauthorized", { status: 401 });
      }
      if (url.includes("/v1/jobs") && init?.method === "POST") {
        return jsonResponse(
          {
            job_id: "job-1",
            conversation_id: "c1",
            message_id: "m1",
            status: "queued",
          },
          201,
        );
      }
      if (url.includes("/v1/agent/status")) {
        return jsonResponse({
          is_ready: true,
          llm_configured: true,
          message: "Ready",
        });
      }
      return jsonResponse([]);
    }) as unknown as typeof globalThis.fetch;

    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.send("Hi"); // no back-off — an auth error can't be retried away

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(urls).toHaveLength(1); // surfaced immediately, no reconnect attempts
  });

  it("detach during backoff stops the reconnect loop (no unstoppable stream)", async () => {
    const partial = msgStart(0) + blockStart(1); // never terminal → would retry
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial], urls),
    });
    await session.connect();

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(50); // first pump done, now in backoff
    session.detach(); // aborts + nulls the controller
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    vi.useRealTimers();

    // Without the captured-signal fix, detach() nulls the controller and the
    // aborted check silently fails, so the loop reconnects to exhaustion.
    expect(urls.length).toBeLessThan(MAX_EVENTS_CALLS);
  });

  // Sharper than the bound above, which passes even when one extra attempt
  // slips out. Detaching during backoff must stop the loop IMMEDIATELY: the
  // per-attempt AbortController is linked to the session signal by an `abort`
  // LISTENER, and a signal aborted while we were sleeping already dispatched
  // that event — so the listener never fires and the fresh controller stays
  // live. That attempt would then reach the network, emit events, and could
  // run a client tool on a session the caller believes is disconnected.
  it("detach during backoff issues NO further /events request", async () => {
    const partial = msgStart(0) + blockStart(1); // never terminal → would retry
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: reconnectFetch([partial], urls),
    });
    await session.connect();

    vi.useFakeTimers();
    const p = session.send("Hi");
    await vi.advanceTimersByTimeAsync(50); // first pump done, now in backoff
    const afterFirst = urls.length;
    session.detach();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    vi.useRealTimers();

    expect(urls).toHaveLength(afterFirst); // not one more round trip
  });

  it("rescues a zombie stream (no bytes, no error, no FIN) via the stall watchdog", async () => {
    const partial = msgStart(0) + blockStart(1) + blockDelta(2, "Hi");
    const terminal = msgStop(3) + DONE;
    const urls: string[] = [];
    let call = 0;
    // First /events connection delivers partial events then goes silent
    // forever — the HTTP/3 zombie mode where reader.read() never settles.
    const fetch = (async (input: unknown, init?: { method?: string }) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("/events")) {
        const i = call++;
        urls.push(url);
        if (i === 0) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(partial)); // …and then nothing, ever
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return sseResponse(terminal);
      }
      if (url.includes("/v1/jobs") && init?.method === "POST") {
        return jsonResponse(
          {
            job_id: "job-1",
            conversation_id: "c1",
            message_id: "m1",
            status: "queued",
          },
          201,
        );
      }
      if (url.includes("/v1/agent/status")) {
        return jsonResponse({
          is_ready: true,
          llm_configured: true,
          message: "Ready",
        });
      }
      return jsonResponse([]);
    }) as unknown as typeof globalThis.fetch;

    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    vi.useFakeTimers();
    const p = session.send("Hi");
    // Stall timeout (135s) + the 0.5s first reconnect backoff, with margin.
    // If SSE_STALL_TIMEOUT_MS moves again this advance must move with it —
    // an advance short of the watchdog leaves the zombie read pending and
    // this test hanging (the constant is module-private, so the coupling is
    // by comment, not import).
    await vi.advanceTimersByTimeAsync(150_000);
    await p;
    vi.useRealTimers();

    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(urls).toHaveLength(2); // watchdog killed the zombie, reconnected once
    expect(urls[1]).toContain("after=2"); // resumed from the last seq before the stall
  });
});
