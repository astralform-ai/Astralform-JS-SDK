import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";

describe("StreamManager", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  it("forwards every send option through to the job request", async () => {
    // StreamManager re-maps SendOptions field by field into session.send, so a
    // field added to ChatSession alone never reaches the wire — which is
    // exactly how imageMode shipped in 4.6.0 without working through
    // manager.send(), the path every consumer actually uses. This asserts on
    // the REQUEST BODY so a missing line in either mapper fails it.
    let body: Record<string, unknown> | undefined;
    const sse = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":1,"stall_count":0,"seq":1,"ts":0}\n',
      "",
      "data: [DONE]\n",
      "",
    ].join("\n");

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/jobs/job-1/events")) {
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/v1/jobs")) {
        body = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            job_id: "job-1",
            conversation_id: "c1",
            message_id: "m1",
            status: "queued",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/agent/status")) {
        return new Response(
          JSON.stringify({ is_ready: true, llm_configured: true, message: "Ready" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();
    const manager = new StreamManager(session);
    await manager.send("Draw a cat", { imageMode: true, planMode: true });

    expect(body?.image_mode).toBe(true);
    // planMode alongside it, so a regression that drops ONE mapping is
    // distinguishable from one that drops the whole options object.
    expect(body?.plan_mode).toBe(true);
  });

  it("treats a failing getActiveJob as no active job and proceeds to replay", async () => {
    // Restoring a conversation: active-job lookup errors, but the
    // manager should still fall through to the completed-jobs replay
    // path and end in the "idle" state. Before the getActiveJob refactor
    // this path was guarded by a bare try/catch around `client.get<…>`;
    // this test pins it after promoting to the typed method.
    let activeJobCalls = 0;
    let jobsCalls = 0;
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;

      if (url.includes("/active-job")) {
        activeJobCalls++;
        return new Response(JSON.stringify({ detail: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/c1/jobs")) {
        jobsCalls++;
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/conversations/c1/messages")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/conversations/c1/events")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const manager = new StreamManager(session);

    await manager.switchTo("c1");

    expect(activeJobCalls).toBe(1);
    expect(jobsCalls).toBeGreaterThanOrEqual(1);
    expect(manager.state).toBe("idle");
    expect(manager.activeConversationId).toBe("c1");
  });

  it("skipHistoryReplay: activates a cached conversation without replaying history when no job is live", async () => {
    // A consumer that caches restored blocks re-opens a conversation with no
    // live job: the manager confirms via /active-job, then moves the pointer +
    // loads messages but does NOT fetch /jobs or /events and does NOT enter the
    // "restoring" state (which is what tells the consumer to clear its cache).
    const calls = { activeJob: 0, jobs: 0, events: 0, messages: 0 };
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/active-job")) {
        calls.activeJob++;
        return new Response(JSON.stringify({ job_id: null, status: "none" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/c1/jobs")) calls.jobs++;
      else if (url.includes("/conversations/c1/events")) calls.events++;
      else if (url.includes("/conversations/c1/messages")) calls.messages++;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const manager = new StreamManager(session);
    const states: string[] = [];
    manager.on((e) => {
      if (e.type === "stateChange") states.push(e.state);
    });

    await manager.switchTo("c1", { skipHistoryReplay: true });

    expect(calls.activeJob).toBe(1); // still confirms no live job (reload/multi-tab safety)
    expect(calls.jobs).toBe(0); // but skips the expensive replay
    expect(calls.events).toBe(0);
    expect(calls.messages).toBe(1); // loaded once for send/regenerate context
    expect(states).not.toContain("restoring");
    expect(manager.state).toBe("idle");
    expect(manager.activeConversationId).toBe("c1");
  });

  it("skipHistoryReplay falls through to a full reconnect when a job is live (reload / other-tab safety)", async () => {
    // The dangerous case: a job is still running server-side (started before
    // this instance existed), so _backgroundJobs is empty. The fast path must
    // NOT skip — it must discover the live job via /active-job and reconnect,
    // which goes through restore() and therefore enters the "restoring" state.
    const calls = { activeJob: 0 };
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/active-job")) {
        calls.activeJob++;
        return new Response(
          JSON.stringify({ job_id: "job-live", status: "running" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // The reconnect SSE stream — a clean terminal (message_stop + [DONE]) so
      // reconnectToJob finalizes without retrying.
      if (url.includes("/jobs/job-live/events")) {
        const terminal =
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
            turn_id: "t1",
            job_id: "job-live",
            stop_reason: "end_turn",
            usage: {},
            total_ms: 10,
            seq: 1,
            ts: 0,
          })}\n\n` + "data: [DONE]\n\n";
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(terminal));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const manager = new StreamManager(session);
    const states: string[] = [];
    manager.on((e) => {
      if (e.type === "stateChange") states.push(e.state);
    });

    await manager.switchTo("c1", { skipHistoryReplay: true });

    expect(calls.activeJob).toBeGreaterThanOrEqual(1);
    // Entered restore() (which the cached shortcut never does) — proof it did
    // not skip the live job.
    expect(states).toContain("restoring");
    expect(manager.state).toBe("idle");
  });

  it("replays /jobs + /events even when /messages fails", async () => {
    // The rendered bubbles come from job_events, not from /messages — that
    // endpoint only supplies user-prompt text for pairing. So a failing (or,
    // before the request deadline, a stalling) /messages must not prevent the
    // replay: the assistant side still renders, only the synthetic user
    // bubble is skipped.
    const calls = { jobs: 0, events: 0, messages: 0 };
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/active-job")) return json({ job_id: null });
      if (url.includes("/conversations/c1/messages")) {
        calls.messages++;
        return new Response(JSON.stringify({ detail: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/c1/jobs")) {
        calls.jobs++;
        return json([{ job_id: "job-done", status: "completed" }]);
      }
      if (url.includes("/conversations/c1/events")) {
        calls.events++;
        return json([
          {
            event: "message_start",
            data: {
              type: "message_start",
              turn_id: "t1",
              job_id: "job-done",
              model: "test-model",
              seq: 0,
              ts: 0,
            },
          },
        ]);
      }
      return json([]);
    };

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const manager = new StreamManager(session);
    const events: string[] = [];
    manager.on((e) => events.push(e.type));

    await manager.switchTo("c1");

    expect(calls.messages).toBe(1);
    expect(calls.jobs).toBeGreaterThanOrEqual(1);
    expect(calls.events).toBe(1); // the replay actually ran
    expect(events).toContain("versionsReady");
    expect(manager.state).toBe("idle");
  });
});
