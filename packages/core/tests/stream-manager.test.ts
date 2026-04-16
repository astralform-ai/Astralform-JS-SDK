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
});
