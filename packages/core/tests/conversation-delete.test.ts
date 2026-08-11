/**
 * Deleting a conversation, and what counts as "deleted".
 *
 * The local drop used to happen no matter what the server said, so a delete
 * that FAILED looked exactly like one that worked: the conversation left the
 * sidebar, survived on the backend, and reappeared on the next device or the
 * next reload. These pin the one status that really does mean "already gone"
 * against the ones that mean the conversation is still there.
 */
import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { ConnectionError, ServerError } from "../src/errors.js";

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

/** Fetch that serves one conversation and fails DELETE with `status`. */
function deleteFailsWith(status: number | null) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    if ((init?.method ?? "GET") === "DELETE") {
      // `null` = the request never lands: not a ServerError at all, so the
      // guard must not assume one.
      if (status === null) throw new TypeError("Failed to fetch");
      return new Response("nope", { status });
    }
    // The LIST endpoint returns a bare array; matching on the exact pathname
    // keeps `DELETE /v1/conversations/{id}` out of it.
    if (parsed.pathname === "/v1/conversations") {
      const now = new Date(0).toISOString();
      return new Response(
        JSON.stringify([
          { id: "c1", title: "c1", message_count: 1, created_at: now, updated_at: now },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function sessionWith(status: number | null) {
  const session = new ChatSession({
    ...baseConfig,
    fetch: deleteFailsWith(status) as unknown as typeof fetch,
  });
  await session.connect();
  return session;
}

describe("deleteConversation", () => {
  it("treats 404 as already deleted and drops it locally", async () => {
    const session = await sessionWith(404);
    // Asserted BEFORE the delete: `not.toContain` on an empty list passes for
    // the wrong reason, which is exactly how a mock with the wrong response
    // shape sails through.
    expect(session.conversations.map((c) => c.id)).toContain("c1");

    await expect(session.deleteConversation("c1")).resolves.toBeUndefined();
    expect(session.conversations.map((c) => c.id)).not.toContain("c1");
  });

  // The conversation is someone else's / still there. Dropping it locally would
  // report a success that did not happen.
  it("rethrows a 403 and keeps the conversation", async () => {
    const session = await sessionWith(403);

    await expect(session.deleteConversation("c1")).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(session.conversations.map((c) => c.id)).toContain("c1");
  });

  it("rethrows a 500 and keeps the conversation", async () => {
    const session = await sessionWith(500);

    await expect(session.deleteConversation("c1")).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(session.conversations.map((c) => c.id)).toContain("c1");
  });

  // Nothing reached the backend at all — the conversation is definitely still
  // there, and this is not even a ServerError, so the guard must not assume one.
  it("rethrows a transport failure and keeps the conversation", async () => {
    const session = await sessionWith(null);

    // Pinned to the type, not merely "something threw": `toBeTruthy` would
    // also pass on an error thrown BY the guard (a future `err.status` read on
    // a non-object), which is the failure this case exists to rule out.
    // `AstralformClient.request` normalises every fetch rejection into
    // ConnectionError, so that is the counterpart to the sibling ServerErrors.
    await expect(session.deleteConversation("c1")).rejects.toBeInstanceOf(
      ConnectionError,
    );
    expect(session.conversations.map((c) => c.id)).toContain("c1");
  });
});
