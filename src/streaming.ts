import {
  AuthenticationError,
  ConnectionError,
  LLMNotConfiguredError,
  RateLimitError,
  ServerError,
  StreamAbortedError,
} from "./errors.js";
import type { ChatStreamEvent, StreamSSEOptions } from "./types.js";

export async function* streamSSE(
  options: StreamSSEOptions,
): AsyncGenerator<ChatStreamEvent> {
  const { url, body, headers, signal, fetchFn } = options;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
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
    // Sanitize server error text: truncate and redact potential credentials
    const text = rawText
      ? rawText.slice(0, 500).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      : "";
    switch (response.status) {
      case 401:
        throw new AuthenticationError();
      case 429:
        throw new RateLimitError();
      case 400: {
        if (
          text.toLowerCase().includes("llm") &&
          text.toLowerCase().includes("configured")
        ) {
          throw new LLMNotConfiguredError();
        }
        throw new ServerError(text || `Bad request (${response.status})`);
      }
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
      // Keep the last incomplete line in the buffer
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
        // Empty lines reset event type (SSE spec)
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
