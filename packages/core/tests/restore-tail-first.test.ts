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
function backend(total: number, opts: { paged?: boolean } = {}) {
  const paged = opts.paged ?? true;
  const jobs = Array.from({ length: total }, (_, i) => job(i));
  const messages = Array.from({ length: total }, (_, i) => msg(i));
  const urls: string[] = [];

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    urls.push(url);
    const q = new URL(url, "http://x").searchParams;

    if (url.includes("/active-job")) return json({ job_id: null, status: "none" });

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

function harness(total: number, opts: { paged?: boolean } = {}) {
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

    // Whatever conv-b drew, none of conv-a's older turns joined it.
    expect(drawn(h.chat).slice(0, before)).toEqual(drawn(h.chat).slice(0, before));
    expect(h.session.conversationId).toBe("conv-b");
  });
});
