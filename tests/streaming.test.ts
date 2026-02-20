import { describe, it, expect } from "vitest";
import { streamSSE } from "../src/streaming.js";
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

describe("streamSSE", () => {
  it("parses SSE events correctly", async () => {
    const mockFetch = createMockResponse([
      'event: message_start\ndata: {"type":"message_start","message_id":"123","conversation_id":"456"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const events = [];
    for await (const event of streamSSE({
      url: "http://test.com/v1/chat/stream",
      body: { message: "Hi" },
      headers: {},
      fetchFn: mockFetch,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("message_start");
    expect(JSON.parse(events[0]!.data).message_id).toBe("123");
    expect(events[1]!.event).toBe("content_block_delta");
    expect(JSON.parse(events[1]!.data).delta.text).toBe("Hello");
  });

  it("handles multi-line chunks", async () => {
    const mockFetch = createMockResponse([
      'event: message_start\ndata: {"type":"message_start","message_id":"1","conversation_id":"2"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\ndata: [DONE]\n\n',
    ]);

    const events = [];
    for await (const event of streamSSE({
      url: "http://test.com/v1/chat/stream",
      body: { message: "test" },
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
      for await (const _ of streamSSE({
        url: "http://test.com/v1/chat/stream",
        body: { message: "Hi" },
        headers: {},
        fetchFn: mockFetch,
      })) {
        // consume
      }
    }).rejects.toThrow(AuthenticationError);
  });

  it("throws RateLimitError on 429", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("Rate limited", { status: 429 });

    await expect(async () => {
      for await (const _ of streamSSE({
        url: "http://test.com/v1/chat/stream",
        body: { message: "Hi" },
        headers: {},
        fetchFn: mockFetch,
      })) {
        // consume
      }
    }).rejects.toThrow(RateLimitError);
  });

  it("throws StreamAbortedError when signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch: typeof globalThis.fetch = async (_, init) => {
      init?.signal?.throwIfAborted();
      return new Response("ok");
    };

    await expect(async () => {
      for await (const _ of streamSSE({
        url: "http://test.com/v1/chat/stream",
        body: { message: "Hi" },
        headers: {},
        signal: controller.signal,
        fetchFn: mockFetch,
      })) {
        // consume
      }
    }).rejects.toThrow(StreamAbortedError);
  });
});
