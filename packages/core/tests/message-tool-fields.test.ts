/**
 * A REST history row carries its tool result typing.
 *
 * `toMessage` is an allowlist: it copies a fixed set of keys and drops every
 * other field the backend sent. The backend's `MessageResponse` has carried
 * `tool_calls`, `sources`, `duration_ms`, `is_error` and `denied_by` since
 * Astralform#1032, and `denial_kind` since #1103 -- none of them reached this
 * SDK, so a client rendering history from REST (older turns paged in on scroll,
 * or the fallback when replay yields nothing) saw a bare row under a generic
 * label instead of the tool row its replayed twin renders.
 *
 * The `role` union was wrong for the same reason: the backend serves
 * "user" | "assistant" | "tool", and "tool" -- the role every one of these rows
 * carries -- was not in the type at all, while "system" (which the backend
 * explicitly skips) was.
 */
import { describe, it, expect } from "vitest";
import { AstralformClient } from "../src/client.js";
import { createMockFetch } from "./helpers.js";

const config = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

/** A `role="tool"` row exactly as the backend serves it. */
const TOOL_ROW = {
  id: "t1",
  conversation_id: "c1",
  role: "tool",
  content: "…",
  created_at: "2026-01-01T00:00:00Z",
  tool_calls: [
    {
      call_id: "call_s1",
      tool_name: "web_search",
      arguments: { query: "small language models" },
      is_client_tool: false,
    },
  ],
  sources: [{ title: "Result one", url: "https://one.example", snippet: "first" }],
  duration_ms: 1200,
  is_error: false,
  denied_by: null,
  denial_kind: null,
};

/** A denied row: `is_error` is FALSE, so the denial fields are the only signal. */
const DENIED_ROW = {
  id: "t2",
  conversation_id: "c1",
  role: "tool",
  content: "…",
  created_at: "2026-01-01T00:00:01Z",
  tool_calls: null,
  sources: null,
  duration_ms: 3,
  is_error: false,
  denied_by: "Requires approval (headless run)",
  denial_kind: "headless",
};

describe("REST history tool rows", () => {
  it("carries result typing through getMessages", async () => {
    const client = new AstralformClient({
      ...config,
      fetch: createMockFetch({
        "/messages": { status: 200, body: [TOOL_ROW] },
      }),
    });

    const [row] = await client.getMessages("c1");
    expect(row.role).toBe("tool");
    expect(row.sources).toEqual([
      { title: "Result one", url: "https://one.example", snippet: "first" },
    ]);
    expect(row.durationMs).toBe(1200);
    expect(row.isError).toBe(false);
    expect(row.toolCalls?.[0]?.toolName).toBe("web_search");
  });

  it("carries the denial's prose AND its machine-readable kind", async () => {
    const client = new AstralformClient({
      ...config,
      fetch: createMockFetch({
        "/messages": { status: 200, body: [DENIED_ROW] },
      }),
    });

    const [row] = await client.getMessages("c1");
    // `denied_by` is prose a client SHOWS; `denial_kind` is what it BRANCHES on.
    expect(row.deniedBy).toBe("Requires approval (headless run)");
    expect(row.denialKind).toBe("headless");
    expect(row.isError).toBe(false);
  });

  it("degrades to the plain shape when the server sends no enrichment", async () => {
    const client = new AstralformClient({
      ...config,
      fetch: createMockFetch({
        "/messages": {
          status: 200,
          body: [
            {
              id: "m1",
              conversation_id: "c1",
              role: "assistant",
              content: "hi",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    });

    const [row] = await client.getMessages("c1");
    expect(row.content).toBe("hi");
    expect(row.sources).toBeUndefined();
    expect(row.denialKind).toBeUndefined();
  });

  it("carries the same fields through the PAGED read", async () => {
    // One mapping serves both reads; a second copy would drift, and the paged
    // path is the one a new client uses.
    const client = new AstralformClient({
      ...config,
      fetch: createMockFetch({
        "/messages": { status: 200, body: [DENIED_ROW] },
      }),
    });

    const page = await client.getMessagesPage("c1", { limit: 50 });
    expect(page.messages[0]?.denialKind).toBe("headless");
    expect(page.messages[0]?.deniedBy).toBe("Requires approval (headless run)");
  });
});

describe("public export surface", () => {
  it("makes ToolSource nameable by a consumer", async () => {
    // `index.ts` re-exports through an EXPLICIT named list -- no `export *` --
    // so a type referenced by `Message.sources` still ships unnameable unless it
    // is on that list. Nothing in-repo imports it, so typecheck cannot catch it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const index = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    // Anchored like `public-exports.test.ts`'s guard: a bare substring match
    // would pass on a mention in a comment, or on `ToolSourceRef`.
    expect(index).toMatch(/^\s*ToolSource,\s*$/m);
  });
});
