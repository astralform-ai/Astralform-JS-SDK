import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import type { ChatEvent, ConversationEvent } from "../src/types.js";

// ``replayTurn`` replays already-fetched events for one completed turn
// synchronously. Fetching (messages once, per-turn events in parallel) is the
// StreamManager's job now, so these tests feed the persisted event arrays
// directly — no fetch mock needed.

describe("session.replayTurn — user_message interleaving", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  // Persisted events for a completed turn (what conversation_events returns).
  // Note: block_delta rows are absent — the backend strips them from the
  // restore path, so replay never sees them.
  const persistedEvents: ConversationEvent[] = [
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

  it("emits user_message before first message_start when content is supplied", () => {
    const session = new ChatSession(baseConfig);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.replayTurn("c1", persistedEvents, "Hello Tony");

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

  it("does NOT emit user_message when userMessageContent is omitted", () => {
    const session = new ChatSession(baseConfig);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.replayTurn("c1", persistedEvents);

    expect(events.find((e) => e.type === "user_message")).toBeUndefined();
  });

  it("emits user_message exactly once even across multiple message_start events in the same turn", () => {
    // A turn with multiple LLM calls (tool use → tool result → LLM again) emits
    // its own message_start/message_stop pair per call, but the user prompt
    // surfaces only at the FIRST message_start of the replay.
    const multiCallEvents: ConversationEvent[] = [
      ...persistedEvents,
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

    const session = new ChatSession(baseConfig);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.replayTurn("c1", multiCallEvents, "Hi");

    const userMessages = events.filter((e) => e.type === "user_message");
    expect(userMessages).toHaveLength(1);
  });

  it("emits user_message before a memory_recall that precedes message_start", () => {
    // Auto-recall is emitted during prompt prep, so in the persisted stream it
    // lands BEFORE message_start (verified in job_events: seq0 memory_recall,
    // seq2 message_start). The synthetic prompt must still lead it, or the
    // recall chip restores above the user's own message.
    const recallFirstEvents: ConversationEvent[] = [
      {
        seq: 0,
        event: "custom",
        data: {
          type: "custom",
          name: "memory_recall",
          data: { memories: [{ id: "m1", content: "likes Micron" }] },
        },
      },
      ...persistedEvents.map((e) => ({ ...e, seq: e.seq + 1 })),
    ];

    const session = new ChatSession(baseConfig);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.replayTurn(
      "c1",
      recallFirstEvents,
      "Reply with exactly: wire cut live",
    );

    const userIdx = events.findIndex((e) => e.type === "user_message");
    const recallIdx = events.findIndex((e) => e.type === "memory_recall");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(recallIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeLessThan(recallIdx);
  });

  it("switchConversation (backward-compat) loads messages and replays history", async () => {
    // ChatSession.switchConversation is documented in the README, so it stays
    // as a convenience for plain-Session consumers even though StreamManager
    // drives restore itself. It must not throw and must replay the events.
    const mockFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const body = url.includes("/events") ? persistedEvents : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.switchConversation("c1");

    // Replayed the persisted turn (block_start → block_stop landed a text block).
    expect(events.some((e) => e.type === "block_start")).toBe(true);
    expect(events.some((e) => e.type === "block_stop")).toBe(true);
  });

  it("replays multiple turns in order, pairing each with its own prompt", () => {
    // Two completed turns replayed back-to-back (StreamManager calls replayTurn
    // once per completed job). Each turn leads with its own user prompt.
    const turn2: ConversationEvent[] = persistedEvents.map((e) => ({
      ...e,
      data: { ...e.data, job_id: "job-2", turn_id: "t2" },
    }));

    const session = new ChatSession(baseConfig);
    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.replayTurn("c1", persistedEvents, "first");
    session.replayTurn("c1", turn2, "second");

    const prompts = events
      .filter((e) => e.type === "user_message")
      .map((e) => (e as Extract<ChatEvent, { type: "user_message" }>).content);
    expect(prompts).toEqual(["first", "second"]);
  });
});
