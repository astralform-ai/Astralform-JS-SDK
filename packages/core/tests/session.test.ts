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
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"claude-opus-4","agent_display_name":"Main Agent","job_id":"job-1","seq":0,"ts":0}\n',
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

    const messageStart = events.find((e) => e.type === "message_start");
    expect(messageStart).toBeDefined();
    if (messageStart?.type === "message_start") {
      expect(messageStart.agentDisplayName).toBe("Main Agent");
    }

    const messageStop = events.find((e) => e.type === "message_stop");
    expect(messageStop).toBeDefined();
    if (messageStop?.type === "message_stop") {
      expect(messageStop.stopReason).toBe("end_turn");
      expect(messageStop.jobId).toBe("job-1");
      expect(messageStop.usage.inputTokens).toBe(10);
      expect(messageStop.usage.outputTokens).toBe(2);
      expect(messageStop.ttfbMs).toBe(40);
    }

    // v2: no more "complete" event — message_stop is terminal
    expect(
      events.find((e) => (e.type as string) === "complete"),
    ).toBeUndefined();

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

  it("send passes uploadIds and planMode to the request", async () => {
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
    await session.send("Hi", {
      uploadIds: ["file-1", "file-2"],
      planMode: true,
    });

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    expect(body.upload_ids).toEqual(["file-1", "file-2"]);
    expect(body.plan_mode).toBe(true);
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

  it("maps SSE error events to structured error ChatEvent", async () => {
    const sseData = [
      'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"Too many conversation turns","job_id":"job-1","seq":0,"ts":0}\n',
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
      expect(errorEvent.code).toBe("rate_limit_exceeded");
      expect(errorEvent.message).toBe("Too many conversation turns");
    }
  });

  it("routes custom events to typed ChatEvent variants", async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"subagent_start","data":{"agent":{"name":"researcher","display_name":"Researcher","avatar_url":null},"task_call_id":"call-1"},"job_id":"job-1","seq":1,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"context_warning","data":{"severity":"warning","utilization_pct":85,"remaining_tokens":15000,"window_tokens":100000,"input_tokens":85000,"message":"Context is 85% full"},"job_id":"job-1","seq":2,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"memory_recall","data":{"memories":[{"id":"m1","content":"user preference"}]},"job_id":"job-1","seq":3,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"tool_approval_requested","data":{"tool_name":"delete_file","call_id":"tc-1","arguments":{"path":"/tmp/test"},"risk_level":"high","reason":"Destructive operation"},"job_id":"job-1","seq":4,"ts":0}\n',
      "",
      'event: custom\ndata: {"type":"custom","name":"state_changed","data":{"state":"waiting_for_tool"},"job_id":"job-1","seq":5,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":50,"stall_count":0,"seq":6,"ts":0}\n',
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

    await session.send("Test custom events");

    // subagent_start
    const subStart = events.find((e) => e.type === "subagent_start");
    expect(subStart).toBeDefined();
    if (subStart?.type === "subagent_start") {
      expect(subStart.agent.name).toBe("researcher");
      expect(subStart.agent.displayName).toBe("Researcher");
      expect(subStart.taskCallId).toBe("call-1");
    }

    // context_warning
    const ctxWarn = events.find((e) => e.type === "context_warning");
    expect(ctxWarn).toBeDefined();
    if (ctxWarn?.type === "context_warning") {
      expect(ctxWarn.severity).toBe("warning");
      expect(ctxWarn.utilizationPct).toBe(85);
      expect(ctxWarn.remainingTokens).toBe(15000);
    }

    // memory_recall
    const memRecall = events.find((e) => e.type === "memory_recall");
    expect(memRecall).toBeDefined();
    if (memRecall?.type === "memory_recall") {
      expect(memRecall.memories).toHaveLength(1);
    }

    // tool_approval_requested
    const toolApproval = events.find(
      (e) => e.type === "tool_approval_requested",
    );
    expect(toolApproval).toBeDefined();
    if (toolApproval?.type === "tool_approval_requested") {
      expect(toolApproval.toolName).toBe("delete_file");
      expect(toolApproval.riskLevel).toBe("high");
    }

    // state_changed
    const stateChanged = events.find((e) => e.type === "state_changed");
    expect(stateChanged).toBeDefined();
    if (stateChanged?.type === "state_changed") {
      expect(stateChanged.state).toBe("waiting_for_tool");
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

    session.conversationId = "c1";

    await session.send("Start");

    const titleEvent = events.find((e) => e.type === "title_generated");
    expect(titleEvent).toBeDefined();
    if (titleEvent?.type === "title_generated") {
      expect(titleEvent.title).toBe("A Great Chat");
    }

    const conv = session.conversations.find((c) => c.id === "c1");
    expect(conv?.title).toBe("A Great Chat");
  });

  it("retry event carries strategy and context_recovery", async () => {
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: retry\ndata: {"type":"retry","attempt":1,"reason":"overloaded","backoff_ms":5000,"strategy":"context_recovery","max_attempts":3,"context_recovery":{"tokens_removed":1000},"job_id":"job-1","seq":1,"ts":0}\n',
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
      "/v1/conversations": [],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.connect();

    const events: ChatEvent[] = [];
    session.on((e) => events.push(e));

    await session.send("retry test");

    const retryEvent = events.find((e) => e.type === "retry");
    expect(retryEvent).toBeDefined();
    if (retryEvent?.type === "retry") {
      expect(retryEvent.strategy).toBe("context_recovery");
      expect(retryEvent.maxAttempts).toBe(3);
      expect(retryEvent.contextRecovery).toEqual({ tokens_removed: 1000 });
    }
  });

  it("backfills conversationId on the first turn of an auto-created conversation", async () => {
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
        conversation_id: "new-conv-42",
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

    // Send without a pre-existing conversationId; backend assigns one.
    await session.send("First turn");

    const userMsg = session.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.conversationId).toBe("new-conv-42");
  });

  it("does not duplicate assistant messages when reconnecting to a running job", async () => {
    // Simulate a two-turn replay — the reconnect path should rely on
    // loadConversation's REST fetch, not synthesise fresh message records.
    const sseData = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","model":"m","job_id":"job-1","seq":0,"ts":0}\n',
      "",
      'event: block_start\ndata: {"type":"block_start","turn_id":"t1","job_id":"job-1","path":[0],"kind":"text","metadata":{},"seq":1,"ts":0}\n',
      "",
      'event: block_delta\ndata: {"type":"block_delta","turn_id":"t1","job_id":"job-1","path":[0],"delta":{"channel":"text","text":"First"},"seq":2,"ts":0}\n',
      "",
      'event: block_stop\ndata: {"type":"block_stop","turn_id":"t1","job_id":"job-1","path":[0],"status":"ok","final":{},"seq":3,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":10,"stall_count":0,"seq":4,"ts":0}\n',
      "",
      'event: message_start\ndata: {"type":"message_start","turn_id":"t2","model":"m","job_id":"job-1","seq":5,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t2","job_id":"job-1","stop_reason":"end_turn","usage":{},"total_ms":10,"stall_count":0,"seq":6,"ts":0}\n',
      "",
      "data: [DONE]\n",
      "",
    ].join("\n");

    const mockFetch = createSessionMockFetch({
      "/v1/jobs/job-1/events": sseData,
      "/v1/project/status": {
        is_ready: true,
        llm_configured: true,
        message: "Ready",
      },
      "/v1/conversations": [],
    });

    const session = new ChatSession({ ...baseConfig, fetch: mockFetch });
    await session.reconnectToJob("job-1");

    // Zero synthesised assistant messages — REST-loaded history is the
    // source of truth for historical turns.
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(
      0,
    );
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
