import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";
import { ServerError } from "../src/errors.js";
import { isToolImageStub, isToolOutputStub } from "../src/types.js";

/**
 * Opt-in stubbed image previews, fetched on demand (Astralform#1178).
 *
 * Previews are hoisted out of a tool's `output` so a stubbed pill keeps its
 * thumbnail — which exempts them from `toolOutputs: "stub"`, and on a
 * picture-heavy conversation left them three quarters of the restore's bytes.
 *
 * The properties that matter, the tool-output suite's plus one:
 *
 * - **Opt-in or it is a wire change.** The default request is byte-identical.
 * - **Independent of `toolOutputs`.** Every installed consumer already sends
 *   that flag and draws `url` directly; turning one on must not send the other.
 * - **One setting, both waves.**
 * - **The fetch is built from the stub alone**, so `job_id` cannot be dropped.
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

const PIXELS = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7,
]);

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
  __stub: "tool_image" as const,
  call_id: "call-1",
  index: 2,
  job_id: "job-3",
  mime_type: "image/png",
  width: 640,
  height: 480,
  bytes: 10,
};

function harness(total = 15, imageStatus = 200) {
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
    if (url.includes("/active-job"))
      return json({ job_id: null, status: "none" });
    if (url.includes("/images/")) {
      if (imageStatus !== 200) {
        return new Response("Tool image not found", { status: imageStatus });
      }
      return new Response(PIXELS, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url.includes("/events")) {
      const preview =
        q.get("tool_images") === "stub"
          ? { ...STUB, job_id: q.get("job_id") }
          : {
              url: "data:image/png;base64,iVBORw0KGgo=",
              mime_type: "image/png",
            };
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
              tool_name: "view_media",
              call_id: "call-1",
              input: {},
              output: "[image shown above: 640x480]",
              is_error: false,
              images: [preview],
            },
          },
        },
      ]);
    }
    const limit = Number(q.get("limit") ?? "0");
    const win = <T>(all: T[], key: (x: T) => string) => {
      if (!limit)
        return { page: all, hasMore: false, next: null as string | null };
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

describe("tool-image stubs", () => {
  it("sends no tool_images param by default", async () => {
    const h = harness();
    await h.manager.switchTo("conv-a");
    await flush();
    expect(eventUrls(h.urls).length).toBeGreaterThan(0);
    expect(eventUrls(h.urls).every((u) => !u.includes("tool_images"))).toBe(
      true,
    );
  });

  it("does not ride along with toolOutputs", async () => {
    // THE compatibility property. Every installed consumer sends
    // `tool_outputs=stub` and draws `url` directly; if turning that on also
    // asked for image stubs, each of them would get broken images.
    const h = harness();
    h.manager.setToolOutputMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    const urls = eventUrls(h.urls);
    expect(urls.every((u) => u.includes("tool_outputs=stub"))).toBe(true);
    expect(urls.every((u) => !u.includes("tool_images"))).toBe(true);
  });

  it("asks for image stubs alone when only they are opted in", async () => {
    const h = harness();
    h.manager.setToolImageMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    const urls = eventUrls(h.urls);
    expect(urls.every((u) => u.includes("tool_images=stub"))).toBe(true);
    expect(urls.every((u) => !u.includes("tool_outputs"))).toBe(true);
  });

  it("asks for both when both are opted in, with job_id alongside", async () => {
    const h = harness();
    h.manager.setToolOutputMode("stub");
    h.manager.setToolImageMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    expect(
      eventUrls(h.urls).every(
        (u) =>
          u.includes("job_id=") &&
          u.includes("tool_outputs=stub") &&
          u.includes("tool_images=stub"),
      ),
    ).toBe(true);
  });

  it("asks for image stubs on paged-in turns too, from the same setting", async () => {
    const h = harness();
    h.manager.setToolImageMode("stub");
    await h.manager.switchTo("conv-a");
    await flush();
    const beforePaging = eventUrls(h.urls).length;

    await h.manager.loadEarlierTurns("conv-a");
    await flush();
    const paged = eventUrls(h.urls).slice(beforePaging);

    expect(paged.length).toBeGreaterThan(0);
    expect(paged.every((u) => u.includes("tool_images=stub"))).toBe(true);
  });

  it("recognises a stub and refuses anything else", () => {
    expect(isToolImageStub(STUB)).toBe(true);
    expect(isToolImageStub({ url: "data:image/png;base64,AAAA" })).toBe(false);
    expect(isToolImageStub(null)).toBe(false);
    // The sibling marker is a different route — never one of these.
    expect(
      isToolImageStub({ __stub: "tool_output", call_id: "c", index: 0 }),
    ).toBe(false);
    expect(isToolOutputStub(STUB)).toBe(false);
  });

  it("refuses a marker without the fields the fetch is built from", () => {
    // Both land in the URL on the next line — `/images/undefined` otherwise.
    const { call_id: _c, ...noCall } = STUB;
    const { index: _i, ...noIndex } = STUB;
    expect(isToolImageStub(noCall)).toBe(false);
    expect(isToolImageStub({ ...STUB, call_id: "" })).toBe(false);
    expect(isToolImageStub(noIndex)).toBe(false);
    expect(isToolImageStub({ ...STUB, index: -1 })).toBe(false);
    expect(isToolImageStub({ ...STUB, index: 1.5 })).toBe(false);
    expect(isToolImageStub({ ...STUB, index: "2" })).toBe(false);
  });

  it("still accepts a stub whose display hints are missing", () => {
    // Dimensions reserve the box; without them the image still resolves.
    expect(
      isToolImageStub({ __stub: "tool_image", call_id: "c", index: 0 }),
    ).toBe(true);
  });

  it("fetches the preview's bytes from the stub alone, job_id included", async () => {
    const h = harness();
    const blob = await h.session.client.getToolImage("conv-a", STUB);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PIXELS);
    const url = h.urls.find((u) => u.includes("/images/"))!;
    expect(url).toContain(
      "/v1/conversations/conv-a/tool-output/call-1/images/2",
    );
    expect(url).toContain("job_id=job-3");
  });

  it("omits job_id when the stub carries none", async () => {
    const h = harness();
    const { job_id: _j, ...unscoped } = STUB;
    await h.session.client.getToolImage("conv-a", unscoped);
    const url = h.urls.find((u) => u.includes("/images/"))!;
    expect(url).not.toContain("job_id");
  });

  it("encodes a call id that is not URL-safe", async () => {
    const h = harness();
    await h.session.client.getToolImage("conv-a", {
      ...STUB,
      call_id: "toolu/a b",
    });
    const url = h.urls.find((u) => u.includes("/images/"))!;
    expect(url).toContain("/tool-output/toolu%2Fa%20b/images/2");
  });

  it("surfaces a missing image as a ServerError carrying 404", async () => {
    // A consumer tells "gone" from "broken" by status, not by prose.
    const h = harness(15, 404);
    const err = await h.session.client
      .getToolImage("conv-a", STUB)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).status).toBe(404);
  });

  it("passes image stubs through replay untouched", async () => {
    // `final` reaches consumers as the wire had it; a stub mangled or dropped
    // on the way through would leave a consumer nothing to resolve.
    const h = harness();
    h.manager.setToolImageMode("stub");
    const seen: unknown[] = [];
    h.session.on((e) => seen.push(e));
    await h.manager.switchTo("conv-a");
    await flush();
    const stops = seen.filter(
      (e) => (e as { type?: string }).type === "block_stop",
    ) as { final?: { images?: unknown[] } }[];
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((e) => isToolImageStub(e.final?.images?.[0]))).toBe(
      true,
    );
  });
});
