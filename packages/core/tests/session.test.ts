import { describe, it, expect, vi } from "vitest";
import { ChatSession } from "../src/session.js";
import type { ChatEvent } from "../src/types.js";
import { createSessionMockFetch } from "./helpers.js";

describe("ChatSession", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  it("connect fetches project status and tools", async () => {
    const mockFetch = createSessionMockFetch({
      "/v1/project/status": {
        is_ready: true,
        llm_configured: true,
        llm_provider: "openai",
        llm_model: "gpt-4o",
        message: "Ready",
      },
      "/v1/conversations": [],
      "/v1/tools": [
        {
          name: "search",
          display_name: "Web Search",
          description: "Search",
        },
      ],
      "/v1/mcp-tools": [],
      "/v1/agents": [],
      "/v1/skills": [],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.connect();

    expect(session.projectStatus).not.toBeNull();
    expect(session.projectStatus!.isReady).toBe(true);
    expect(session.platformTools).toHaveLength(1);
    expect(session.enabledTools.has("search")).toBe(true);
    expect(events.some((e) => e.type === "connected")).toBe(true);
  });

  it("send creates a job and streams events", async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","message_id":"m1","conversation_id":"c1","model_display_name":"GPT-4o","seq":0}\n',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"},"seq":1}\n',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"},"seq":2}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","stop_reason":"end_turn","title":"Greeting","seq":3}\n',
      "",
      'event: done\ndata: {"data":"[DONE]","seq":4}\n',
      "",
      "data: [DONE]\n",
      "",
    ].join("\n");

    const mockFetch = createSessionMockFetch({
      "/v1/jobs/job-1/events": sseData,
      "/v1/jobs": {
        job_id: "job-1",
        conversation_id: "c1",
        message_id: "m1",
        status: "queued",
      },
      "/v1/project/status": {
        is_ready: true,
        llm_configured: true,
        message: "Ready",
      },
      "/v1/conversations": [],
      "/v1/tools": [],
      "/v1/mcp-tools": [],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.send("Hi");

    const chunks = events.filter((e) => e.type === "chunk");
    expect(chunks).toHaveLength(2);

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type === "complete") {
      expect(complete.content).toBe("Hello world");
      expect(complete.title).toBe("Greeting");
    }

    expect(session.messages).toHaveLength(2); // user + assistant
    expect(session.conversationId).toBe("c1");
  });

  it("toggleTool toggles enabled state", () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: async () => new Response(),
    });

    session.enabledTools.add("search");
    const removed = session.toggleTool("search");
    expect(removed).toBe(false);
    expect(session.enabledTools.has("search")).toBe(false);

    const added = session.toggleTool("search");
    expect(added).toBe(true);
    expect(session.enabledTools.has("search")).toBe(true);
  });

  it("createNewConversation creates and switches", async () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: async () => new Response(),
    });

    const id = await session.createNewConversation();
    expect(id).toBeDefined();
    expect(session.conversationId).toBe(id);
    expect(session.conversations).toHaveLength(1);
    expect(session.messages).toHaveLength(0);
  });

  it("disconnect aborts streaming and emits disconnected", () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: async () => new Response(),
    });

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    session.disconnect();

    expect(session.isStreaming).toBe(false);
    expect(events.some((e) => e.type === "disconnected")).toBe(true);
  });

  it("on returns unsubscribe function", () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: async () => new Response(),
    });
    const handler = vi.fn();

    const unsub = session.on(handler);
    session.disconnect(); // triggers an event
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    session.disconnect();
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });
});
