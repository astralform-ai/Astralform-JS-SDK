import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";

describe("StreamManager", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

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

  it("skipHistoryReplay: activates a cached conversation without fetching or replaying history", async () => {
    // A consumer that caches restored blocks re-opens a conversation: the
    // manager should move the pointer + load messages but NOT look up the
    // active job, NOT fetch /jobs or /events, and NOT enter the "restoring"
    // state (which is what tells the consumer to clear its cached blocks).
    const calls = { activeJob: 0, jobs: 0, events: 0, messages: 0 };
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/active-job")) calls.activeJob++;
      else if (url.endsWith("/c1/jobs")) calls.jobs++;
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

    expect(calls.activeJob).toBe(0);
    expect(calls.jobs).toBe(0);
    expect(calls.events).toBe(0);
    expect(calls.messages).toBe(1); // loaded once for send/regenerate context
    expect(states).not.toContain("restoring");
    expect(manager.state).toBe("idle");
    expect(manager.activeConversationId).toBe("c1");
  });
});
