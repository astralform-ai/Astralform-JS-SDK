import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import type { ChatEvent } from "../src/types.js";

// Local helper: conversation events + messages endpoints return JSON arrays,
// so we can't reuse ``createSessionMockFetch`` (which treats any ``/events``
// URL as an SSE stream for the live-job streaming path).
function jsonMock(responses: Record<string, unknown>): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("session.switchConversation — user_message interleaving", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  // Persisted events for a completed turn (what conversation_events returns).
  const persistedEvents = [
    {
      seq: 0,
      event: "message_start",
      data: {
        type: "message_start",
        turn_id: "t1",
        model: "m",
        job_id: "job-1",
        agent_name: "tli",
        agent_display_name: "Tony",
      },
    },
    {
      seq: 1,
      event: "block_start",
      data: {
        type: "block_start",
        turn_id: "t1",
        job_id: "job-1",
        path: [0],
        kind: "text",
        metadata: {},
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
        final: { text: "hello" },
      },
    },
    {
      seq: 3,
      event: "message_stop",
      data: {
        type: "message_stop",
        turn_id: "t1",
        job_id: "job-1",
        stop_reason: "end_turn",
        usage: {},
        total_ms: 50,
        stall_count: 0,
      },
    },
  ];

  it("emits user_message before first message_start when content is supplied", async () => {
    const mockFetch = jsonMock({
      "/v1/conversations/c1/messages": [],
      "/v1/conversations/c1/events": persistedEvents,
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.switchConversation("c1", "job-1", "Hello Tony");

    const userIdx = events.findIndex((e) => e.type === "user_message");
    const startIdx = events.findIndex((e) => e.type === "message_start");

    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeLessThan(startIdx);

    const userEvent = events[userIdx] as Extract<
      ChatEvent,
      { type: "user_message" }
    >;
    expect(userEvent.content).toBe("Hello Tony");
  });

  it("does NOT emit user_message when userMessageContent is omitted", async () => {
    const mockFetch = jsonMock({
      "/v1/conversations/c1/messages": [],
      "/v1/conversations/c1/events": persistedEvents,
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.switchConversation("c1", "job-1");

    expect(events.find((e) => e.type === "user_message")).toBeUndefined();
  });

  it("emits user_message exactly once even across multiple message_start events in the same job", async () => {
    // Simulates a turn with multiple LLM calls (tool use → tool result → LLM again).
    // Each LLM call emits its own message_start/message_stop pair, but the user
    // prompt should only surface at the FIRST message_start of the replay.
    const multiTurnEvents = [
      ...persistedEvents,
      // Second LLM call within the same job
      {
        seq: 4,
        event: "message_start",
        data: {
          type: "message_start",
          turn_id: "t1",
          model: "m",
          job_id: "job-1",
          agent_name: "tli",
        },
      },
      {
        seq: 5,
        event: "message_stop",
        data: {
          type: "message_stop",
          turn_id: "t1",
          job_id: "job-1",
          stop_reason: "end_turn",
          usage: {},
          total_ms: 20,
          stall_count: 0,
        },
      },
    ];

    const mockFetch = jsonMock({
      "/v1/conversations/c1/messages": [],
      "/v1/conversations/c1/events": multiTurnEvents,
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.switchConversation("c1", "job-1", "Hi");

    const userMessages = events.filter((e) => e.type === "user_message");
    expect(userMessages).toHaveLength(1);
  });
});
