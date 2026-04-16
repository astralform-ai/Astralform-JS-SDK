import { describe, it, expect } from "vitest";
import { mapSseToChat, replayEvents, type RawSseEvent } from "../src/replay.js";
import { translateDelta } from "../src/translate.js";

describe("translateDelta", () => {
  it("translates text delta", () => {
    const result = translateDelta({ channel: "text", text: "hello" });
    expect(result).toEqual({ channel: "text", text: "hello" });
  });

  it("translates input delta (snake_case to camelCase)", () => {
    const result = translateDelta({
      channel: "input",
      partial_json: '{"key":',
    });
    expect(result).toEqual({ channel: "input", partialJson: '{"key":' });
  });

  it("translates input_arg delta", () => {
    const result = translateDelta({
      channel: "input_arg",
      arg_name: "content",
      text: "abc",
    });
    expect(result).toEqual({
      channel: "inputArg",
      argName: "content",
      text: "abc",
    });
  });

  it("translates awaiting_approval status delta", () => {
    const result = translateDelta({
      channel: "status",
      status: "awaiting_approval",
      note: "Needs user approval",
    });
    expect(result).toEqual({
      channel: "status",
      status: "awaiting_approval",
      note: "Needs user approval",
    });
  });
});

describe("mapSseToChat", () => {
  it("translates message_start with agent identity", () => {
    const raw: RawSseEvent = {
      seq: 0,
      event: "message_start",
      data: {
        type: "message_start",
        turn_id: "t1",
        model: "claude-opus-4",
        agent_name: "researcher",
        agent_display_name: "Research Agent",
        agent_avatar_url: "https://example.com/avatar.png",
        job_id: "j1",
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message_start",
      turnId: "t1",
      model: "claude-opus-4",
      agentName: "researcher",
      agentDisplayName: "Research Agent",
      agentAvatarUrl: "https://example.com/avatar.png",
    });
  });

  it("translates message_stop with jobId", () => {
    const raw: RawSseEvent = {
      seq: 5,
      event: "message_stop",
      data: {
        type: "message_stop",
        turn_id: "t1",
        job_id: "job-1",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cached_tokens: 20 },
        ttfb_ms: 40,
        total_ms: 1000,
        stall_count: 0,
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message_stop",
      jobId: "job-1",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 20 },
    });
  });

  it("does not synthesize complete event", () => {
    const raw: RawSseEvent = {
      seq: 1,
      event: "message_stop",
      data: {
        type: "message_stop",
        turn_id: "t1",
        job_id: "j1",
        stop_reason: "end_turn",
        usage: {},
        total_ms: 50,
        stall_count: 0,
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("message_stop");
  });

  it("translates error event to structured format", () => {
    const raw: RawSseEvent = {
      seq: 0,
      event: "error",
      data: {
        type: "error",
        code: "rate_limit_exceeded",
        message: "Too fast",
        block_path: [0, 1],
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "error") {
      expect(events[0]!.code).toBe("rate_limit_exceeded");
      expect(events[0]!.message).toBe("Too fast");
      expect(events[0]!.blockPath).toEqual([0, 1]);
    }
  });

  it("translates retry with strategy fields", () => {
    const raw: RawSseEvent = {
      seq: 0,
      event: "retry",
      data: {
        type: "retry",
        attempt: 2,
        reason: "overloaded",
        backoff_ms: 5000,
        strategy: "context_recovery",
        max_attempts: 3,
        context_recovery: { tokens_removed: 500 },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "retry") {
      expect(events[0]!.strategy).toBe("context_recovery");
      expect(events[0]!.maxAttempts).toBe(3);
      expect(events[0]!.contextRecovery).toEqual({ tokens_removed: 500 });
    }
  });

  it("translates subagent_start custom event", () => {
    const raw: RawSseEvent = {
      seq: 1,
      event: "custom",
      data: {
        type: "custom",
        name: "subagent_start",
        data: {
          agent: {
            name: "coder",
            display_name: "Code Writer",
            avatar_url: null,
            description: "Writes code",
          },
          task_call_id: "tc-1",
        },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "subagent_start") {
      expect(events[0]!.agent.name).toBe("coder");
      expect(events[0]!.agent.displayName).toBe("Code Writer");
      expect(events[0]!.taskCallId).toBe("tc-1");
    }
  });

  it("translates context_warning custom event", () => {
    const raw: RawSseEvent = {
      seq: 2,
      event: "custom",
      data: {
        type: "custom",
        name: "context_warning",
        data: {
          severity: "critical",
          utilization_pct: 95,
          remaining_tokens: 5000,
          window_tokens: 100000,
          input_tokens: 95000,
          message: "Context almost full",
        },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "context_warning") {
      expect(events[0]!.severity).toBe("critical");
      expect(events[0]!.utilizationPct).toBe(95);
      expect(events[0]!.remainingTokens).toBe(5000);
    }
  });

  it("translates tool_approval_requested custom event", () => {
    const raw: RawSseEvent = {
      seq: 3,
      event: "custom",
      data: {
        type: "custom",
        name: "tool_approval_requested",
        data: {
          tool_name: "rm_rf",
          call_id: "c-1",
          arguments: { path: "/" },
          risk_level: "critical",
          reason: "Destructive operation",
        },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "tool_approval_requested") {
      expect(events[0]!.toolName).toBe("rm_rf");
      expect(events[0]!.riskLevel).toBe("critical");
    }
  });

  it("translates memory_recall custom event", () => {
    const raw: RawSseEvent = {
      seq: 1,
      event: "custom",
      data: {
        type: "custom",
        name: "memory_recall",
        data: { memories: [{ id: "m1", content: "preference" }] },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "memory_recall") {
      expect(events[0]!.memories).toHaveLength(1);
    }
  });

  it("translates state_changed custom event", () => {
    const raw: RawSseEvent = {
      seq: 4,
      event: "custom",
      data: {
        type: "custom",
        name: "state_changed",
        data: { state: "completed" },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    if (events[0]!.type === "state_changed") {
      expect(events[0]!.state).toBe("completed");
    }
  });

  it("falls through unknown custom events to generic", () => {
    const raw: RawSseEvent = {
      seq: 1,
      event: "custom",
      data: {
        type: "custom",
        name: "future_event",
        data: { foo: "bar" },
      },
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("custom");
    if (events[0]!.type === "custom") {
      expect(events[0]!.name).toBe("future_event");
    }
  });

  it("skips done sentinel", () => {
    const raw: RawSseEvent = {
      seq: 99,
      event: "done",
      data: {},
    };
    const events = mapSseToChat(raw);
    expect(events).toHaveLength(0);
  });
});

describe("replayEvents", () => {
  it("interleaves user messages at message_start boundaries", () => {
    const sseEvents: RawSseEvent[] = [
      {
        seq: 0,
        event: "message_start",
        data: {
          type: "message_start",
          turn_id: "t1",
          model: "m",
          job_id: "j1",
        },
      },
      {
        seq: 1,
        event: "message_stop",
        data: {
          type: "message_stop",
          turn_id: "t1",
          job_id: "j1",
          stop_reason: "end_turn",
          usage: {},
          total_ms: 50,
          stall_count: 0,
        },
      },
    ];
    const userMessages = [{ role: "user", content: "Hello" }];

    const handledEvents: string[] = [];
    const addedBlocks: { content: string }[] = [];

    replayEvents(
      sseEvents,
      userMessages,
      (e) => handledEvents.push(e.type),
      (b) => addedBlocks.push({ content: b.content }),
    );

    expect(addedBlocks).toHaveLength(1);
    expect(addedBlocks[0]!.content).toBe("Hello");
    expect(handledEvents).toContain("message_start");
    expect(handledEvents).toContain("message_stop");
  });
});
