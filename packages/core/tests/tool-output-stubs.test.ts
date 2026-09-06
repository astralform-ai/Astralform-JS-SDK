import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import { isToolOutputStub } from "../src/types.js";

/**
 * Opt-in stubbed tool outputs, resolved on demand.
 *
 * Tool outputs are the largest rows a restore carries. Phase 1's cursor bounds
 * how MANY the first render pays for; stubbing bounds how BIG each one is.
 *
 * The properties that matter:
 *
 * - **It is opt-in or it is a wire change.** The default request must be
 *   byte-identical to what every installed client already sends.
 * - **One setting, both waves.** Stubs on scroll-up but not in the tail would
 *   be worse than none: the same pill behaves differently by position.
 * - **The fetch must carry `job_id`.** Without it a version-switched read 404s
 *   on exactly the pills it is displaying.
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

const STUB = {
  __stub: "tool_output" as const,
  call_id: "call-1",
  size_bytes: 12345,
  job_id: "job-3",
};

function harness(total = 15) {
  const urls: string[] = [];
  const jobs = Array.from({ length: total }, (_, i) => ({
    job_id: `job-${i}`,
    status: "completed",
    message_id: `m-${i}`,
  }));
  const messages = Array.from({ length: total }, (_, i) => ({
    id: `m-${i}`,
    conversation_id: "conv-a",
    role: "user",
    content: `prompt ${i}`,
    created_at: "2026-01-01T00:00:00Z",
    seq: i,
  }));

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    urls.push(url);
    const q = new URL(url, "http://x").searchParams;
    if (url.includes("/active-job")) return json({ job_id: null, status: "none" });
    if (url.includes("/tool-output/")) {
      return json({ call_id: "call-1", output: "the full body" });
    }
    if (url.includes("/events")) {
      const stubbed = q.get("tool_outputs") === "stub";
      return json([
        {
          seq: 0,
          event: "block_stop",
          data: {
            type: "block_stop",
            turn_id: "t1",
            job_id: q.get("job_id"),
            path: [0],
            status: "ok",
            final: {
              tool_name: "web_search",
              call_id: "call-1",
              input: {},
              output: stubbed ? STUB : "the full body",
              is_error: false,
            },
          },
        },
      ]);
    }
    const limit = Number(q.get("limit") ?? "0");
    const win = <T,>(all: T[], key: (x: T) => string) => {
      if (!limit) return { page: all, hasMore: false, next: null as string | null };
      const before = q.get("before") ?? q.get("before_seq");
      let end = all.length;
      if (before) end = all.findIndex((x) => key(x) === before);
      const start = Math.max(0, end - limit);
      return {
        page: all.slice(start, end),
        hasMore: start > 0,
        next: start > 0 ? key(all[start]) : null,
      };
    };
    if (url.includes("/messages")) {
      const { page, hasMore, next } = win(messages, (m) => String(m.seq));
      return json(page, {
        "X-Has-More": String(hasMore),
        ...(next ? { "X-Next-Before-Seq": next } : {}),
      });
    }
    const { page, hasMore, next } = win(jobs, (j) => j.job_id);
    return json(page, {
      "X-Has-More": String(hasMore),
      ...(next ? { "X-Next-Before": next } : {}),
    });
  };

  const session = new ChatSession({ ...baseConfig, fetch } as never);
  const manager = new StreamManager(session);
  return { session, manager, urls };
}

const eventUrls = (urls: string[]) => urls.filter((u) => u.includes("/events"));

describe("tool-output stubs", () => {
  it("sends no tool_outputs param by default", async () => {
    // Opt-in or it is a wire change: the default request must look exactly
    // like the one every installed client already makes.
    const h = harness();
    await h.manager.switchTo("conv-a");
    await flush();
    expect(eventUrls(h.urls).length).toBeGreaterThan(0);
    expect(eventUrls(h.urls).every((u) => !u.includes("tool_outputs"))).toBe(true);
  });

  it("asks for stubs on the newest page when opted in", async () => {
    const h = harness();
    h.manager.setToolOutputMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    expect(eventUrls(h.urls).every((u) => u.includes("tool_outputs=stub"))).toBe(true);
  });

  it("asks for stubs on paged-in turns too, from the same setting", async () => {
    // One setting, both waves. Stubs in one and not the other means the same
    // pill behaves differently depending on where it sits in the transcript.
    const h = harness();
    h.manager.setToolOutputMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    const beforePaging = eventUrls(h.urls).length;

    await h.manager.loadEarlierTurns("conv-a");
    await flush();
    const paged = eventUrls(h.urls).slice(beforePaging);

    expect(paged.length).toBeGreaterThan(0);
    expect(paged.every((u) => u.includes("tool_outputs=stub"))).toBe(true);
  });

  it("keeps job_id alongside the stub request", async () => {
    // Both params on the same URL — the job scope is what makes a
    // version-switched read's stub resolvable at all.
    const h = harness();
    h.manager.setToolOutputMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    expect(
      eventUrls(h.urls).every((u) => u.includes("job_id=") && u.includes("tool_outputs=stub")),
    ).toBe(true);
  });

  it("recognises a stub and refuses anything else", () => {
    expect(isToolOutputStub(STUB)).toBe(true);
    expect(isToolOutputStub("the full body")).toBe(false);
    expect(isToolOutputStub(null)).toBe(false);
    expect(isToolOutputStub({ __stub: "something_else" })).toBe(false);
    // A tool that returns its own `stub` key must not read as one of ours.
    expect(isToolOutputStub({ stub: true })).toBe(false);
  });

  it("fetches the body scoped to the stub's job", async () => {
    const h = harness();
    const out = await h.session.client.getToolOutput("conv-a", STUB.call_id, STUB.job_id);
    expect(out).toBe("the full body");
    const fetchUrl = h.urls.find((u) => u.includes("/tool-output/"))!;
    expect(fetchUrl).toContain("/tool-output/call-1");
    expect(fetchUrl).toContain("job_id=job-3");
  });

  it("omits job_id when the stub carries none", async () => {
    // The backend omits it when the event had no job id, and the unscoped
    // fetch is then the correct one.
    const h = harness();
    await h.session.client.getToolOutput("conv-a", "call-1");
    const fetchUrl = h.urls.find((u) => u.includes("/tool-output/"))!;
    expect(fetchUrl).not.toContain("job_id");
  });

  it("passes a stub through replay without tripping the malformed-event catch", async () => {
    // `replayTurn` swallows events that throw. A stub reaching that catch
    // would take its whole turn's other blocks down with it, silently.
    const h = harness();
    h.manager.setToolOutputMode("stub");
    const seen: unknown[] = [];
    h.session.on((e) => seen.push(e));
    await h.manager.switchTo("conv-a");
    await flush();
    const stops = seen.filter(
      (e) => (e as { type?: string }).type === "block_stop",
    ) as { final?: { output?: unknown } }[];
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some((e) => isToolOutputStub(e.final?.output))).toBe(true);
  });
});
