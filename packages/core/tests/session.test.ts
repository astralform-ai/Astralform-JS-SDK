import { describe, it, expect, vi } from "vitest";
import { ChatSession } from "../src/session.js";
import type { ChatEvent } from "../src/types.js";
import { RateLimitError } from "../src/errors.js";
import { createSessionMockFetch } from "./helpers.js";

describe("ChatSession", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  it("connect fetches project status and agents", async () => {
    const mockFetch = createSessionMockFetch({
      "/v1/project/status": {
        is_ready: true,
        llm_configured: true,
        llm_provider: "openai",
        llm_model: "gpt-4o",
        message: "Ready",
      },
      "/v1/conversations": [],
      "/v1/agents": [
        {
          name: "helper",
          display_name: "Helper",
          description: "Helps",
          is_orchestrator: false,
          is_enabled: true,
        },
      ],
      "/v1/skills": [],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.connect();

    expect(session.projectStatus).not.toBeNull();
    expect(session.projectStatus!.isReady).toBe(true);
    expect(session.agents).toHaveLength(1);
    expect(events.some((e) => e.type === "connected")).toBe(true);
  });

  it("send creates a job and streams block events", async () => {
    // New wire protocol: message_start → block_start(text) → block_delta(text) × 2 → block_stop → message_stop
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"claude-opus-4","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: block_start\ndata: {"type":"block_start","turn_id":"t1","job_id":"job-1","path":[0],"kind":"text","metadata":{},"seq":1,"ts":0}\n',
      "",
      'event: block_delta\ndata: {"type":"block_delta","turn_id":"t1","job_id":"job-1","path":[0],"delta":{"channel":"text","text":"Hello"},"seq":2,"ts":0}\n',
      "",
      'event: block_delta\ndata: {"type":"block_delta","turn_id":"t1","job_id":"job-1","path":[0],"delta":{"channel":"text","text":" world"},"seq":3,"ts":0}\n',
      "",
      'event: block_stop\ndata: {"type":"block_stop","turn_id":"t1","job_id":"job-1","path":[0],"status":"ok","final":{"text":"Hello world"},"seq":4,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2},"ttfb_ms":40,"total_ms":1000,"stall_count":0,"seq":5,"ts":0}\n',
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
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.send("Hi");

    // New protocol emits typed block events
    const blockStarts = events.filter((e) => e.type === "block_start");
    expect(blockStarts).toHaveLength(1);

    const blockDeltas = events.filter((e) => e.type === "block_delta");
    expect(blockDeltas).toHaveLength(2);
    if (blockDeltas[0]?.type === "block_delta") {
      expect(blockDeltas[0].delta.channel).toBe("text");
      if (blockDeltas[0].delta.channel === "text") {
        expect(blockDeltas[0].delta.text).toBe("Hello");
      }
    }

    const blockStops = events.filter((e) => e.type === "block_stop");
    expect(blockStops).toHaveLength(1);

    const messageStop = events.find((e) => e.type === "message_stop");
    expect(messageStop).toBeDefined();
    if (messageStop?.type === "message_stop") {
      expect(messageStop.stopReason).toBe("end_turn");
      expect(messageStop.usage.inputTokens).toBe(10);
      expect(messageStop.usage.outputTokens).toBe(2);
      expect(messageStop.ttfbMs).toBe(40);
    }

    // Session synthesizes ``complete`` after message_stop so legacy
    // consumers continue working.
    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();

    expect(session.messages).toHaveLength(2); // user + assistant
    expect(session.conversationId).toBe("c1");
  });

  it("toggleClientTool toggles enabled state", () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: async () => new Response(),
    });

    session.enabledClientTools.add("my_tool");
    const removed = session.toggleClientTool("my_tool");
    expect(removed).toBe(false);
    expect(session.enabledClientTools.has("my_tool")).toBe(false);

    const added = session.toggleClientTool("my_tool");
    expect(added).toBe(true);
    expect(session.enabledClientTools.has("my_tool")).toBe(true);
  });

  it("send passes uploadIds to the request", async () => {
    let capturedBody: string | undefined;
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":50,"stall_count":0,"seq":1,"ts":0}\n',
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
    });

    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/jobs") && !url.includes("/events")) {
        capturedBody = init?.body as string;
      }
      return mockFetch(input, init);
    };

    const session = new ChatSession({
      ...baseConfig,
      fetch: wrappedFetch,
    });
    await session.connect();
    await session.send("Hi", { uploadIds: ["file-1", "file-2"] });

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    expect(body.upload_ids).toEqual(["file-1", "file-2"]);
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

  it("maps SSE rate-limit errors to RateLimitError", async () => {
    const sseData = [
      'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"Too many conversation turns","retry_after":25,"scope":"project","policy_id":"conversation.turn","limit":60,"remaining":0,"reset_at":1767225600,"request_id":"req_sse_123","job_id":"job-1","seq":0,"ts":0}\n',
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
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.send("Hit rate limit");

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toBeInstanceOf(RateLimitError);
      const rateErr = errorEvent.error as RateLimitError;
      expect(rateErr.message).toBe("Too many conversation turns");
      expect(rateErr.retryAfterSec).toBe(25);
      expect(rateErr.scope).toBe("project");
      expect(rateErr.policyId).toBe("conversation.turn");
      expect(rateErr.limit).toBe(60);
      expect(rateErr.remaining).toBe(0);
      expect(rateErr.requestId).toBe("req_sse_123");
      expect(rateErr.resetAt).toBe(1767225600 * 1000);
    }
  });

  it("custom event (title_generated) updates conversation title", async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"title_generated","data":{"title":"A Great Chat"},"job_id":"job-1","seq":1,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":50,"stall_count":0,"seq":2,"ts":0}\n',
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
      "/v1/conversations": [
        {
          id: "c1",
          title: "Untitled",
          message_count: 0,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    // Pre-set the conversationId so the title update path is hit
    session.conversationId = "c1";

    await session.send("Start");

    const titleEvent = events.find((e) => e.type === "title_generated");
    expect(titleEvent).toBeDefined();
    if (titleEvent?.type === "title_generated") {
      expect(titleEvent.title).toBe("A Great Chat");
    }

    // Internal conversations array updated in place
    const conv = session.conversations.find((c) => c.id === "c1");
    expect(conv?.title).toBe("A Great Chat");
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
