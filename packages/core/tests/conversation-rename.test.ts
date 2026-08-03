/**
 * Conversation rename.
 *
 * The server names a conversation once, from its first turn; this is the only
 * path that changes that label afterwards. Two properties carry the weight:
 *
 * 1. The server does NOT bump `updated_at` for a rename — the list is ordered
 *    `updated_at DESC`, and relabelling is not activity. A client that stamped
 *    its own timestamp would reintroduce exactly the reordering the server
 *    avoids, so these tests pin the timestamp surviving untouched.
 * 2. The write is server-first, not optimistic. Nothing refetches a
 *    conversation already in the loaded list, so a locally-applied title that
 *    the server rejected would persist until a full reload.
 */
import { describe, it, expect } from "vitest";
import { AstralformClient } from "../src/client.js";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import { ServerError } from "../src/errors.js";

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

const CREATED = "2026-07-01T10:00:00Z";
const UPDATED = "2026-07-02T11:30:00Z";

function renamed(title: string) {
  return {
    id: "c1",
    title,
    message_count: 7,
    created_at: CREATED,
    updated_at: UPDATED,
  };
}

/**
 * Serves one conversation, and lets a test observe or reject the PATCH.
 */
function renameFetch(opts: { status?: number; title?: string } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

    if (method === "PATCH") {
      const status = opts.status ?? 200;
      if (status !== 200) {
        return new Response("nope", { status });
      }
      const body = JSON.parse(init!.body as string) as { title: string };
      return new Response(JSON.stringify(renamed(opts.title ?? body.title)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/v1/conversations?")) {
      return new Response(JSON.stringify([renamed("Ship the URL router")]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("AstralformClient.renameConversation", () => {
  it("PATCHes the conversation with the new title", async () => {
    const { fetch, calls } = renameFetch();
    const client = new AstralformClient({ ...baseConfig, fetch });

    await client.renameConversation("c1", "Q3 earnings");

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("http://localhost:8000/v1/conversations/c1");
    expect(patch.body).toEqual({ title: "Q3 earnings" });
  });

  it("maps snake_case to camelCase", async () => {
    const { fetch } = renameFetch();
    const client = new AstralformClient({ ...baseConfig, fetch });

    const conv = await client.renameConversation("c1", "Q3 earnings");

    expect(conv).toEqual({
      id: "c1",
      title: "Q3 earnings",
      messageCount: 7,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
  });

  it("percent-encodes the id", async () => {
    const { fetch, calls } = renameFetch();
    const client = new AstralformClient({ ...baseConfig, fetch });

    await client.renameConversation("a/b c", "Q3 earnings");

    expect(calls.find((c) => c.method === "PATCH")!.url).toContain(
      "/v1/conversations/a%2Fb%20c",
    );
  });

  it("surfaces a server rejection", async () => {
    const { fetch } = renameFetch({ status: 422 });
    const client = new AstralformClient({ ...baseConfig, fetch });

    await expect(client.renameConversation("c1", "   ")).rejects.toBeInstanceOf(
      ServerError,
    );
  });
});

describe("ChatSession.renameConversation", () => {
  it("updates the entry the sidebar reads", async () => {
    const { fetch } = renameFetch();
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await session.renameConversation("c1", "Q3 earnings");

    expect(session.conversations.find((c) => c.id === "c1")!.title).toBe(
      "Q3 earnings",
    );
  });

  // The whole point of the server not bumping it: a rename must not move the
  // conversation in a list ordered by this field.
  it("leaves updatedAt alone", async () => {
    const { fetch } = renameFetch();
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await session.renameConversation("c1", "Q3 earnings");

    expect(session.conversations.find((c) => c.id === "c1")!.updatedAt).toBe(
      UPDATED,
    );
  });

  // The server trims; the client must not assume its own string won.
  it("stores the server's title, not the caller's", async () => {
    const { fetch } = renameFetch({ title: "Q3 earnings" });
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await session.renameConversation("c1", "  Q3 earnings  ");

    expect(session.conversations.find((c) => c.id === "c1")!.title).toBe(
      "Q3 earnings",
    );
  });

  it("does not apply a rejected rename locally", async () => {
    const { fetch } = renameFetch({ status: 422 });
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await expect(session.renameConversation("c1", "   ")).rejects.toThrow();
    expect(session.conversations.find((c) => c.id === "c1")!.title).toBe(
      "Ship the URL router",
    );
  });

  it("renaming an id that is not in the loaded list is not an error", async () => {
    const { fetch } = renameFetch();
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await expect(
      session.renameConversation("not-loaded", "Q3 earnings"),
    ).resolves.toBeUndefined();
  });
});

describe("StreamManager.renameConversation", () => {
  // Unlike delete, a rename has no active-conversation or background-job
  // bookkeeping — but it still has to be reachable from the manager, which is
  // the only surface the chat app holds.
  it("reaches the session", async () => {
    const { fetch } = renameFetch();
    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();
    const manager = new StreamManager(session);

    await manager.renameConversation("c1", "Q3 earnings");

    expect(session.conversations.find((c) => c.id === "c1")!.title).toBe(
      "Q3 earnings",
    );
  });
});
