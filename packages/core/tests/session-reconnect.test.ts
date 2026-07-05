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
    if (url.includes("/v1/project/status")) {
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
});
