import { describe, it, expect } from "vitest";
import { streamJobSSE } from "../src/streaming.js";
import {
  AuthenticationError,
  RateLimitError,
  StreamAbortedError,
} from "../src/errors.js";

function createMockResponse(
  chunks: string[],
  status = 200,
): typeof globalThis.fetch {
  return async () => {
    const encoder = new TextEncoder();
    let chunkIndex = 0;

    const stream = new ReadableStream({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(encoder.encode(chunks[chunkIndex]!));
          chunkIndex++;
        } else {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

describe("streamJobSSE", () => {
  it("parses GET-based SSE events correctly", async () => {
    const mockFetch = createMockResponse([
      'event: message_start\ndata: {"type":"message_start","message_id":"m1","conversation_id":"c1","seq":0}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"},"seq":1}\n\n',
      "data: [DONE]\n\n",
    ]);

    const events = [];
    for await (const event of streamJobSSE({
      url: "http://test.com/v1/jobs/j1/events?after=-1",
      headers: {},
      fetchFn: mockFetch,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("message_start");
    expect(JSON.parse(events[0]!.data).seq).toBe(0);
    expect(events[1]!.event).toBe("content_block_delta");
    expect(JSON.parse(events[1]!.data).seq).toBe(1);
  });

  it("handles multi-line chunks", async () => {
    const mockFetch = createMockResponse([
      'event: message_start\ndata: {"type":"message_start","message_id":"1","conversation_id":"2","seq":0}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"},"seq":1}\n\ndata: [DONE]\n\n',
    ]);

    const events = [];
    for await (const event of streamJobSSE({
      url: "http://test.com/v1/jobs/j1/events?after=-1",
      headers: {},
      fetchFn: mockFetch,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it("throws AuthenticationError on 401", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401 });

    await expect(async () => {
      for await (const _ of streamJobSSE({
        url: "http://test.com/v1/jobs/j1/events",
        headers: {},
        fetchFn: mockFetch,
      })) {
        // consume
      }
    }).rejects.toThrow(AuthenticationError);
  });

  it("throws RateLimitError with metadata on 429", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 30;
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("Too Many Requests", {
        status: 429,
        headers: {
          "Retry-After": "30",
          "X-RateLimit-Limit": "120",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(resetSec),
          "X-Request-ID": "req_stream_123",
        },
      });

    try {
      for await (const _ of streamJobSSE({
        url: "http://test.com/v1/jobs/j1/events",
        headers: {},
        fetchFn: mockFetch,
      })) {
        // consume
      }
      throw new Error("Expected streamJobSSE to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rateErr = err as RateLimitError;
      expect(rateErr.retryAfterSec).toBe(30);
      expect(rateErr.limit).toBe(120);
      expect(rateErr.remaining).toBe(0);
      expect(rateErr.requestId).toBe("req_stream_123");
      expect(rateErr.resetAt).toBe(resetSec * 1000);
    }
  });

  it("throws StreamAbortedError when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch: typeof globalThis.fetch = async (_, init) => {
      init?.signal?.throwIfAborted();
      return new Response("ok");
    };

    await expect(async () => {
      for await (const _ of streamJobSSE({
        url: "http://test.com/v1/jobs/j1/events",
        headers: {},
        signal: controller.signal,
        fetchFn: mockFetch,
      })) {
        // consume
      }
    }).rejects.toThrow(StreamAbortedError);
  });
});
