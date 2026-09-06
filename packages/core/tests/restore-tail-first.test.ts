import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import {
  StreamManager,
  RESTORE_TURN_PAGE_SIZE,
  type StreamManagerEvent,
} from "../src/stream-manager.js";
import type { ChatEvent } from "../src/types.js";

/**
 * Restore renders the NEWEST page of turns and pages older ones on demand.
 *
 * The complaint behind #1052 is that time-to-content scales with transcript
 * size: restore fetched every message, every job, and every job's full event
 * log before painting anything. `963af62` already put the three opening
 * requests on the wire together, which fixed round-trip DEPTH; what remains is
 * COUNT and BYTES, and that is what these tests pin.
 *
 * Two properties, and neither alone is enough:
 *
 * - **The request count before first render is independent of conversation
 *   length.** That is the flat-load claim, and it is the whole issue.
 * - **Paging changes WHEN turns arrive, never WHICH or in what order.** A
 *   faster restore that drops or reorders a turn is not a fix.
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

function msg(n: number) {
  return {
    id: `m-${n}`,
    conversation_id: "conv-a",
    role: "user",
    content: `prompt ${n}`,
    created_at: "2026-01-01T00:00:00Z",
    seq: n,
  };
}

function job(n: number) {
  return { job_id: `job-${n}`, status: "completed", message_id: `m-${n}` };
}

function events(n: number) {
  return [
    {
      seq: 0,
      event: "message_start",
      data: { type: "message_start", turn_id: `t${n}`, model: "m", job_id: `job-${n}` },
    },
    {
      seq: 1,
      event: "block_stop",
      data: {
        type: "block_stop",
        turn_id: `t${n}`,
        job_id: `job-${n}`,
        path: [0],
        status: "ok",
        final: { text: `answer ${n}` },
      },
    },
  ];
}

/**
 * A backend holding `total` turns, serving them through the real cursor
 * protocol — `limit`/`before` in, `X-Has-More`/`X-Next-Before` out.
 *
 * `paged: false` models an OLD server: it ignores the unknown `limit` param,
 * returns everything, and sets no headers.
 */
function backend(
  total: number,
  opts: { paged?: boolean; hiddenPromptAt?: number } = {},
) {
  const paged = opts.paged ?? true;
  const jobs = Array.from({ length: total }, (_, i) => job(i));
  // A turn whose `message_id` names a row the message list does not contain —
  // what a goal continuation looks like on the wire.
  const messages = Array.from({ length: total }, (_, i) => msg(i)).filter(
    (m) => m.seq !== opts.hiddenPromptAt,
  );
  const urls: string[] = [];

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    urls.push(url);
    const q = new URL(url, "http://x").searchParams;

    if (url.includes("/active-job")) return json({ job_id: null, status: "none" });

    // Only conv-a holds the fixture. Any other conversation is EMPTY, which is
    // what lets a switch-away test tell a leak from an ordinary restore of the
    // conversation switched to — with one fixture answering every id, conv-b
    // draws conv-a's turns legitimately and the assertion proves nothing.
    if (!url.includes("/conv-a/")) return json([]);

    if (url.includes("/events")) {
      const id = q.get("job_id") ?? "";
      const n = Number(id.replace("job-", ""));
      return json(events(n));
    }

    // Newest-first window, returned oldest-first — the server's contract.
    const window = <T>(all: T[], cursorOf: (x: T) => string) => {
      const limit = Number(q.get("limit") ?? "0");
      if (!paged || !limit) return { page: all, hasMore: false, next: null };
      const before = q.get("before") ?? q.get("before_seq");
      let end = all.length;
      if (before) end = all.findIndex((x) => cursorOf(x) === before);
      const start = Math.max(0, end - limit);
      return {
        page: all.slice(start, end),
        hasMore: start > 0,
        next: start > 0 ? cursorOf(all[start]) : null,
      };
    };

    if (url.includes("/messages")) {
      const { page, hasMore, next } = window(messages, (m) => String(m.seq));
      return json(page, {
        ...(paged ? { "X-Has-More": String(hasMore) } : {}),
        ...(next != null && paged ? { "X-Next-Before-Seq": next } : {}),
      });
    }
    if (url.includes("/jobs")) {
      const { page, hasMore, next } = window(jobs, (j) => j.job_id);
      return json(page, {
        ...(paged ? { "X-Has-More": String(hasMore) } : {}),
        ...(next && paged ? { "X-Next-Before": next } : {}),
      });
    }
    return json([]);
  };
  return { fetch, urls };
}

function harness(
  total: number,
  opts: { paged?: boolean; hiddenPromptAt?: number } = {},
) {
  const be = backend(total, opts);
  const session = new ChatSession({ ...baseConfig, fetch: be.fetch } as never);
  const manager = new StreamManager(session);
  const chat: ChatEvent[] = [];
  const mgr: StreamManagerEvent[] = [];
  session.on((e) => chat.push(e));
  manager.on((e) => mgr.push(e));
  return { ...be, session, manager, chat, mgr };
}

/** The turns a restore actually drew, in order. */
function drawn(chat: ChatEvent[]): string[] {
  return chat
    .filter((e) => e.type === "user_message")
    .map((e) => (e as { content: string }).content);
}

describe("tail-first restore", () => {
  it("issues 3 + N requests before first render, whatever the length", async () => {
    // THE flat-load claim, made mechanical. N is the page size, never `total`.
    const short = harness(1);
    await short.manager.switchTo("conv-a");
    await flush();

    const long = harness(60);
    await long.manager.switchTo("conv-a");
    await flush();

    const opening = (urls: string[]) =>
      urls.filter((u) => !u.includes("/events")).length;
    const eventFetches = (urls: string[]) =>
      urls.filter((u) => u.includes("/events")).length;

    expect(opening(short.urls)).toBe(3);
    expect(opening(long.urls)).toBe(3);
    expect(eventFetches(short.urls)).toBe(1);
    expect(eventFetches(long.urls)).toBe(RESTORE_TURN_PAGE_SIZE);
    // The point, stated as one assertion: a 60-turn conversation costs the
    // same as a 1-turn one plus a bounded page, not 60 event fetches.
    expect(long.urls.length).toBeLessThan(60);
  });

  it("draws only the newest page, newest turns last", async () => {
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();

    const shown = drawn(h.chat);
    expect(shown).toHaveLength(RESTORE_TURN_PAGE_SIZE);
    expect(shown.at(-1)).toBe("prompt 24");
    expect(shown[0]).toBe("prompt 15");
  });

  it("a full walk reproduces the whole transcript, in order", async () => {
    // Paging changes WHEN turns arrive, never which or in what order.
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    while (h.session.hasMoreTurns) {
      await h.manager.loadEarlierTurns("conv-a");
      await flush();
    }
    const shown = drawn(h.chat);
    // Every turn, exactly once.
    expect(new Set(shown).size).toBe(25);
    expect(shown).toHaveLength(25);

    // The EMISSION order is pages newest-first, each page internally
    // oldest-first — which is precisely why `historyPageStart`/`End` bracket a
    // page rather than the SDK claiming to know where it goes. A consumer that
    // appended these in arrival order would render the transcript in blocks of
    // ten, backwards.
    expect(shown.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `prompt ${15 + i}`),
    );
    expect(shown.slice(10, 20)).toEqual(
      Array.from({ length: 10 }, (_, i) => `prompt ${5 + i}`),
    );
    expect(shown.slice(20)).toEqual(
      Array.from({ length: 5 }, (_, i) => `prompt ${i}`),
    );
  });

  it("brackets a paged-in page so the consumer can place it", async () => {
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    h.mgr.length = 0;

    await h.manager.loadEarlierTurns("conv-a");
    await flush();

    const start = h.mgr.findIndex((e) => e.type === "historyPageStart");
    const end = h.mgr.findIndex((e) => e.type === "historyPageEnd");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect((h.mgr[start] as { position: string }).position).toBe("prepend");
  });

  it("no-ops once nothing older remains", async () => {
    const h = harness(3);
    await h.manager.switchTo("conv-a");
    await flush();
    expect(h.session.hasMoreTurns).toBe(false);
    expect(await h.manager.loadEarlierTurns("conv-a")).toBe(0);
  });

  it("does not stack duplicate pages when the sentinel re-fires", async () => {
    // A scroll handler fires far faster than the request completes.
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    const before = drawn(h.chat).length;

    const both = await Promise.all([
      h.manager.loadEarlierTurns("conv-a"),
      h.manager.loadEarlierTurns("conv-a"),
    ]);
    await flush();

    expect(both.filter((n) => n > 0)).toHaveLength(1);
    expect(drawn(h.chat).length).toBe(before + RESTORE_TURN_PAGE_SIZE);
  });

  it("does not advance the cursor when a walk stops partway", async () => {
    // `break` falls THROUGH to the cursor writes, so advancing there moved the
    // cursor past turns the loop never emitted — a permanent hole in the
    // scrolled-up transcript, with `historyPageEnd` reporting success over it.
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    const cursorBefore = h.session.oldestTurnCursor;
    const drawnBefore = drawn(h.chat).length;

    // A live turn taking the view over mid-replay is one of the three stop
    // conditions, and the only one that does not also clear the cursor — which
    // is exactly what makes it the one that can prove this.
    let tripped = false;
    h.session.on((e) => {
      if (!tripped && e.type === "user_message") {
        tripped = true;
        h.session.isStreaming = true;
      }
    });

    const emitted = await h.manager.loadEarlierTurns("conv-a");
    await flush();

    // It stopped: fewer than a full page drawn.
    expect(emitted).toBeLessThan(RESTORE_TURN_PAGE_SIZE);
    expect(drawn(h.chat).length).toBeLessThan(drawnBefore + RESTORE_TURN_PAGE_SIZE);
    // And the cursor did NOT skip the turns it failed to draw.
    expect(h.session.oldestTurnCursor).toBe(cursorBefore);
    expect(h.session.hasMoreTurns).toBe(true);
    // The bracket closed, AND it says the page was partial — without which a
    // consumer keeps the prefix it buffered and the retry (the cursor did not
    // advance) draws those same turns a second time.
    const end = h.mgr.find((e) => e.type === "historyPageEnd") as
      | { complete: boolean; hasMore: boolean }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.complete).toBe(false);
    expect(end!.hasMore).toBe(true);
  });

  it("does not re-draw earlier prompts when a page holds a hidden prompt", async () => {
    // A goal continuation's seed is hidden from the message list, so a turn in
    // the page can have a `message_id` that resolves to nothing. The prompt
    // is hidden at 20 — the MIDDLE of the newest page (15…24), not its head:
    // `planRestore` classifies a job as a continuation only past `firstLinked`,
    // so an unlinked HEAD job sends the whole page down the positional branch
    // instead and pairs it with the wrong prompts entirely. Hiding the head is
    // a different scenario wearing this one's name.
    const h = harness(25, { hiddenPromptAt: 20 });
    await h.manager.switchTo("conv-a");
    await flush();
    const first = drawn(h.chat);
    // The head of the newest page still pairs with its own prompt — i.e. the
    // fixture did not tip `planRestore` into the positional branch.
    expect(first[0]).toBe("prompt 15");

    await h.manager.loadEarlierTurns("conv-a");
    await flush();
    const all = drawn(h.chat);

    // Nothing drawn by the newest page is drawn again by the older one.
    const repeated = all.slice(first.length).filter((c) => first.includes(c));
    expect(repeated).toEqual([]);
  });

  it("clears the turn cursor when loadConversation moves the pointer", async () => {
    // The manager is not the only door. `loadConversation(id, { limit })` is
    // public and is the documented windowed entry point, so a consumer can
    // move the pointer without ever going through `switchTo`. Left standing,
    // the next `loadEarlierTurns` passes its guard holding the PREVIOUS
    // conversation's cursor and prepends whatever that returns into this one.
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    const aCursor = h.session.oldestTurnCursor;
    expect(aCursor).not.toBe(null);

    await h.session.loadConversation("conv-b", { limit: 40 });
    expect(h.session.oldestTurnCursor).toBe(null);
    // And the flag with it: nothing below that point in `loadConversation`
    // writes it, so left true beside a null cursor a sentinel driven off it
    // never retires.
    expect(h.session.hasMoreTurns).toBe(false);

    // And the guard therefore refuses to page conv-b on conv-a's cursor.
    h.urls.length = 0;
    expect(await h.manager.loadEarlierTurns("conv-b")).toBe(0);
    expect(h.urls.some((u) => u.includes(`before=${aCursor}`))).toBe(false);
  });

  it("reloads the whole branch when a send interrupts a windowed restore", async () => {
    // The window is decided synchronously at restore entry, but whether this
    // restore will page is only settled once `replayHistory` clears its first
    // abort check. A send landing in between — nothing gates one during a
    // restore — stops the replay with the window already installed and no
    // cursor written: a transcript truncated to one page that no pager can
    // extend. That path has to fall back to the whole branch, as it did
    // before windowing.
    const h = harness(60);
    // Lands the moment the restore announces itself: after the window was
    // decided, before any request has answered.
    h.manager.on((e) => {
      if (e.type === "stateChange" && e.state === "restoring") {
        h.session.isStreaming = true;
      }
    });
    await h.manager.switchTo("conv-a");
    await flush();

    expect(h.session.hasMoreTurns).toBe(false);
    expect(h.session.oldestTurnCursor).toBe(null);
    // The whole branch, not the window the restore opened with.
    expect(h.session.messages.length).toBe(60);
    expect(h.session.oldestMessageSeq).toBe(null);
  });

  it("does not truncate a restore that will never replay or page", async () => {
    // When a send has already taken the view, the job list is not fetched and
    // `replayHistory` never runs, so nothing writes a turn cursor. Windowing
    // the MESSAGE load there truncated the transcript to one page with no
    // pager able to extend it — strictly worse than the unbounded load this
    // path did before the PR.
    const h = harness(25);
    h.session.isStreaming = true; // a send owns the view

    await h.manager.switchTo("conv-a");
    await flush();

    // The whole branch loaded, not a 40-message window.
    expect(h.session.messages.length).toBe(25);
    // And no load-more affordance is offered, because nothing can serve it.
    expect(h.session.hasMoreTurns).toBe(false);
    const windowed = h.urls.filter(
      (u) => u.includes("/messages") && u.includes("limit="),
    );
    expect(windowed).toEqual([]);
  });

  it("never claims more turns without a cursor to fetch them with", async () => {
    // `hasMoreTurns` gates a pager that needs a cursor. Written from the
    // MESSAGE page it could be true while the cursor was null, so the pager
    // failed its own guard on every call and a sentinel driven off the flag
    // could never retire.
    // 60 turns, so the 40-message window genuinely reports older MESSAGES —
    // without that the message page never says `hasMore` and this asserts
    // nothing about where the flag comes from.
    const h = harness(60);
    await h.session.loadConversation("conv-a", { limit: 40 });
    expect(h.session.hasMoreTurns).toBe(false);
    expect(h.session.oldestTurnCursor).toBe(null);

    // And after a real restore the two agree.
    await h.manager.switchTo("conv-a");
    await flush();
    expect(h.session.hasMoreTurns).toBe(true);
    expect(h.session.oldestTurnCursor).not.toBe(null);
  });

  it("degrades to one complete page against a server without the cursor", async () => {
    // FastAPI ignores an unknown query param, so an old backend returns the
    // whole list with no headers. That must read as "everything arrived",
    // never as an error or as a page with more behind it.
    const h = harness(25, { paged: false });
    await h.manager.switchTo("conv-a");
    await flush();

    expect(h.session.hasMoreTurns).toBe(false);
    expect(drawn(h.chat)).toHaveLength(25);
    expect(await h.manager.loadEarlierTurns("conv-a")).toBe(0);
  });

  it("stops paging into a conversation the session has left", async () => {
    const h = harness(25);
    await h.manager.switchTo("conv-a");
    await flush();
    const before = drawn(h.chat).length;

    const paging = h.manager.loadEarlierTurns("conv-a");
    await h.manager.switchTo("conv-b");
    await paging;
    await flush();

    // Snapshot, not a self-comparison. The previous form compared
    // `drawn(...).slice(0, before)` to itself and held for any implementation
    // — including one that poured conv-a's whole history into conv-b.
    const shown = drawn(h.chat);
    expect(shown).toHaveLength(before);
    expect(
      shown.every((c) => Number(c.replace("prompt ", "")) >= 15),
    ).toBe(true);
    expect(h.session.conversationId).toBe("conv-b");
  });
});
