/**
 * Creates a mock fetch that matches URL patterns and returns JSON responses.
 * For patterns containing "chat/stream", returns the body as raw SSE text.
 */
export function createMockFetch(
  responses: Record<string, { status: number; body: unknown }>,
): typeof globalThis.fetch {
  return async (input) => {
    const url = extractUrl(input);
    for (const [pattern, resp] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

/**
 * Creates a mock fetch for SSE streaming and JSON endpoints.
 * Entries whose key contains "chat/stream" are returned as SSE text streams.
 * All other entries are returned as JSON with status 200.
 */
export function createSessionMockFetch(
  responses: Record<string, unknown>,
): typeof globalThis.fetch {
  return async (input) => {
    const url = extractUrl(input);

    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        if (pattern.includes("chat/stream")) {
          const encoder = new TextEncoder();
          const sseData = body as string;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseData));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
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

function extractUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
