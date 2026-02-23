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
 * Creates a mock fetch for job-based SSE streaming and JSON endpoints.
 * Entries whose key contains "/jobs/" and "/events" are returned as SSE text streams.
 * Entries whose key contains "chat/stream" are returned as SSE text streams (legacy).
 * All other entries are returned as JSON with status 200 (or custom status).
 */
export function createSessionMockFetch(
  responses: Record<string, unknown>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = extractUrl(input);

    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        // SSE stream patterns
        if (pattern.includes("chat/stream") || pattern.includes("/events")) {
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

        // JSON POST responses (e.g., /v1/jobs)
        if (typeof body === "object" && body !== null) {
          const obj = body as Record<string, unknown>;
          // Check if it's a status/body wrapper
          if ("_status" in obj && "_body" in obj) {
            return new Response(JSON.stringify(obj._body), {
              status: obj._status as number,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        return new Response(JSON.stringify(body), {
          status:
            pattern.includes("/jobs") && init?.method === "POST" ? 201 : 200,
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
