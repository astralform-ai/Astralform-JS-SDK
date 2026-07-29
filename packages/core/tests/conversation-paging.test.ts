/**
 * Conversation-list paging.
 *
 * The list is ordered ``updated_at DESC`` and paged by offset, and the array it
 * lands in is ALSO mutated locally (``createNewConversation`` and the
 * auto-created conversation in ``consumeJobStream`` both unshift). The offset
 * therefore cannot be ``conversations.length`` — these tests pin the cases
 * where those two numbers diverge, since every one of them shows up as
 * silently missing history rather than as an error.
 */
import { describe, it, expect } from "vitest";
import { ChatSession, CONVERSATION_PAGE_SIZE } from "../src/session.js";

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

function conv(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    message_count: 1,
    created_at: now,
    updated_at: now,
  };
}

/** A page of `n` synthetic conversations starting at `offset`. */
function page(offset: number, n: number) {
  return Array.from({ length: n }, (_, i) => conv(`c${offset + i}`));
}

/**
 * Mock fetch that serves `total` conversations, honouring limit/offset, and
 * records the offsets it was asked for.
 */
function pagingFetch(
  total: number,
  opts: { overrides?: Record<number, unknown[]> } = {},
) {
  const offsets: number[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url);
    // Only the LIST endpoint. ``DELETE /v1/conversations/{id}`` shares the
    // prefix, and counting it as a page request would make these assertions
    // pass or fail for reasons that have nothing to do with paging.
    if (parsed.pathname === "/v1/conversations") {
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      offsets.push(offset);
      const body =
        opts.overrides?.[offset] ??
        page(offset, Math.max(0, Math.min(limit, total - offset)));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // agent status / agents / skills — connect() tolerates whatever.
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, offsets };
}

describe("conversation paging", () => {
  it("connect seeds page 1 and reports more when the page is full", async () => {
    const { fetch } = pagingFetch(CONVERSATION_PAGE_SIZE * 2);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();

    expect(session.conversations).toHaveLength(CONVERSATION_PAGE_SIZE);
    expect(session.hasMoreConversations).toBe(true);
  });

  it("a short first page means there is nothing more to load", async () => {
    const { fetch, offsets } = pagingFetch(3);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    expect(session.hasMoreConversations).toBe(false);

    // ...and asking anyway must not issue a request.
    const before = offsets.length;
    await expect(session.loadMoreConversations()).resolves.toEqual([]);
    expect(offsets).toHaveLength(before);
  });

  it("loadMore appends the next page and stops at the end", async () => {
    const total = CONVERSATION_PAGE_SIZE + 10;
    const { fetch, offsets } = pagingFetch(total);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    const appended = await session.loadMoreConversations();

    expect(offsets).toEqual([0, CONVERSATION_PAGE_SIZE]);
    expect(appended).toHaveLength(10);
    expect(session.conversations).toHaveLength(total);
    expect(session.hasMoreConversations).toBe(false);
    // No duplicates, and order is preserved oldest-page-last.
    expect(new Set(session.conversations.map((c) => c.id)).size).toBe(total);
    expect(session.conversations[total - 1].id).toBe(`c${total - 1}`);
  });

  it("a locally-created conversation does not push the offset past a row", async () => {
    // The regression this guards: createNewConversation unshifts a conversation
    // the server has never returned. An offset of conversations.length would
    // then request page 2 one row too far and silently drop a conversation.
    const { fetch, offsets } = pagingFetch(CONVERSATION_PAGE_SIZE * 2);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    await session.createNewConversation();
    expect(session.conversations).toHaveLength(CONVERSATION_PAGE_SIZE + 1);

    await session.loadMoreConversations();

    expect(offsets).toEqual([0, CONVERSATION_PAGE_SIZE]);
    expect(session.conversations.map((c) => c.id)).toContain(
      `c${CONVERSATION_PAGE_SIZE}`,
    );
  });

  it("deleting a server-sourced conversation pulls the offset back one", async () => {
    // Deleting shortens the server list, so every later page shifts up by one.
    // Without the adjustment the next page would skip a conversation.
    const { fetch, offsets } = pagingFetch(CONVERSATION_PAGE_SIZE * 2);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    await session.deleteConversation("c0");
    await session.loadMoreConversations();

    expect(offsets).toEqual([0, CONVERSATION_PAGE_SIZE - 1]);
  });

  it("deleting a purely local conversation leaves the offset alone", async () => {
    const { fetch, offsets } = pagingFetch(CONVERSATION_PAGE_SIZE * 2);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    const localId = await session.createNewConversation();
    await session.deleteConversation(localId);
    await session.loadMoreConversations();

    expect(offsets).toEqual([0, CONVERSATION_PAGE_SIZE]);
  });

  it("a conversation re-served in a later page is not duplicated", async () => {
    // updated_at DESC + offset paging: a conversation bumped to the top
    // mid-scroll can appear in page 2 having already been in page 1.
    const { fetch } = pagingFetch(CONVERSATION_PAGE_SIZE * 2, {
      overrides: {
        [CONVERSATION_PAGE_SIZE]: [conv("c0"), conv("c50"), conv("c51")],
      },
    });
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    const appended = await session.loadMoreConversations();

    expect(appended.map((c) => c.id)).toEqual(["c50", "c51"]);
    const ids = session.conversations.map((c) => c.id);
    expect(ids.filter((id) => id === "c0")).toHaveLength(1);
  });

  it("concurrent loadMore calls issue exactly one request", async () => {
    // An IntersectionObserver fires far faster than the request resolves.
    const { fetch, offsets } = pagingFetch(CONVERSATION_PAGE_SIZE * 3);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    const [a, b] = await Promise.all([
      session.loadMoreConversations(),
      session.loadMoreConversations(),
    ]);

    expect(offsets).toEqual([0, CONVERSATION_PAGE_SIZE]);
    // Exactly one of the two did the work; the other no-opped.
    expect([a.length, b.length].sort()).toEqual([0, CONVERSATION_PAGE_SIZE]);
  });

  it("a failed page can be retried", async () => {
    let fail = true;
    const inner = pagingFetch(CONVERSATION_PAGE_SIZE * 2);
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("offset=50") && fail) {
        fail = false;
        throw new Error("network down");
      }
      return inner.fetch(input, init);
    }) as typeof globalThis.fetch;

    const session = new ChatSession({ ...baseConfig, fetch });
    await session.connect();

    await expect(session.loadMoreConversations()).rejects.toThrow();
    // Still flagged as having more, and not wedged behind the in-flight guard.
    expect(session.hasMoreConversations).toBe(true);
    expect(session.isLoadingConversations).toBe(false);

    const appended = await session.loadMoreConversations();
    expect(appended).toHaveLength(CONVERSATION_PAGE_SIZE);
  });

  it("reconnect resets paging instead of carrying the offset over", async () => {
    const { fetch, offsets } = pagingFetch(CONVERSATION_PAGE_SIZE * 3);
    const session = new ChatSession({ ...baseConfig, fetch });

    await session.connect();
    await session.loadMoreConversations();
    await session.connect();
    await session.loadMoreConversations();

    // Second connect re-seeds page 1, so the follow-up page is 50 again — not 150.
    expect(offsets).toEqual([
      0,
      CONVERSATION_PAGE_SIZE,
      0,
      CONVERSATION_PAGE_SIZE,
    ]);
    expect(session.conversations).toHaveLength(CONVERSATION_PAGE_SIZE * 2);
  });
});
