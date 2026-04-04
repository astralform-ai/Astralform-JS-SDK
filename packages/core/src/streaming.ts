import {
  AuthenticationError,
  ConnectionError,
  ServerError,
  StreamAbortedError,
} from "./errors.js";
import { createRateLimitErrorFromHttp } from "./rate-limit.js";
import type { ChatStreamEvent, StreamJobSSEOptions } from "./types.js";
import { sanitizeErrorText } from "./utils.js";

/**
 * GET-based SSE stream for job events.
 */
export async function* streamJobSSE(
  options: StreamJobSSEOptions,
): AsyncGenerator<ChatStreamEvent> {
  const { url, headers, signal, fetchFn } = options;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new StreamAbortedError();
    }
    throw new ConnectionError(
      err instanceof Error ? err.message : "Failed to connect",
    );
  }

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    const text = rawText ? sanitizeErrorText(rawText) : "";
    switch (response.status) {
      case 401:
        throw new AuthenticationError();
      case 429:
        throw createRateLimitErrorFromHttp(response, rawText);
      default:
        throw new ServerError(text || `HTTP ${response.status}`);
    }
  }

  if (!response.body) {
    throw new ConnectionError("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            return;
          }
          yield { event: currentEvent || "message", data };
        }
        if (line === "") {
          currentEvent = "";
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new StreamAbortedError();
    }
    throw err;
  } finally {
    reader.releaseLock();
  }
}
