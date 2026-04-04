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
      'event: message_start\ndata: {"type":"message_start","message_id":"m1","conversation_id":"c1","seq":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","stop_reason":"end_turn","seq":1}\n',
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

    // Wrap to capture the /v1/jobs POST body
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

  it("asset_created event emits camelCase fields", async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","message_id":"m1","conversation_id":"c1","seq":0}\n',
      "",
      'event: asset_created\ndata: {"type":"asset_created","asset_id":"abc123","name":"report.pdf","url":"https://cdn.example.com/report.pdf","media_type":"application/pdf","size_bytes":5000,"seq":1}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","stop_reason":"end_turn","seq":2}\n',
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

    await session.send("Generate a PDF");

    const assetEvent = events.find((e) => e.type === "asset_created");
    expect(assetEvent).toBeDefined();
    if (assetEvent?.type === "asset_created") {
      expect(assetEvent.assetId).toBe("abc123");
      expect(assetEvent.name).toBe("report.pdf");
      expect(assetEvent.url).toBe("https://cdn.example.com/report.pdf");
      expect(assetEvent.mediaType).toBe("application/pdf");
      expect(assetEvent.sizeBytes).toBe(5000);
    }
  });

  it("maps SSE rate-limit errors to RateLimitError", async () => {
    const sseData = [
      'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"Too many conversation turns","retry_after":25,"scope":"project","policy_id":"conversation.turn","limit":60,"remaining":0,"reset_at":1767225600,"request_id":"req_sse_123","seq":0}\n',
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
