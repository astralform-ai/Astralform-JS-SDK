import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import {
  StreamManager,
  type StreamManagerEvent,
} from "../src/stream-manager.js";

/**
 * A parked background job has to be forgotten when it ends.
 *
 * `_backgroundJobs` maps a conversation this instance left mid-turn to the job
 * it left running there. Every mutation was local bookkeeping — park on
 * switch-away, claim on switch-back, delete on conversation delete — and
 * NOTHING consulted the server once the job's own stream was detached, so an
 * entry outlived its run for the life of the page. Consumers read the map as a
 * liveness signal (astralform-chat's list-poll cadence and tab title both key
 * off it), so a stale entry means "working" forever: an extra list request
 * every 25s per open tab, and a spinner on a settled conversation.
 *
 * The reconciliation point is the conversation list, which is the one read
 * that already carries `activeJobId` per row. A refreshed page is an
 * authoritative answer for every row it carries; a conversation the page does
 * not mention is answered by the per-conversation probe the switch path
 * already trusts.
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Let every pending fetch chain settle — microtasks alone are not enough,
 *  since each mocked request resolves through several await points. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A promise plus its resolver, for holding one endpoint open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

function conversationRow(id: string, activeJobId?: string | null) {
  return {
    id,
    title: id,
    message_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...(activeJobId === undefined ? {} : { active_job_id: activeJobId }),
  };
}

/**
 * A backend where conversation A has a live turn held open on `events`.
 *
 * `activeJobs` is mutable on purpose: the switch-away has to see A idle (so
 * the initial restore replays instead of reconnecting), and the refresh that
 * follows has to be able to answer either way — the server's answer CHANGING
 * is the whole subject of these tests.
 */
function scenario() {
  const events = gate();
  const activeJobs: Record<string, string | null> = {
    "conv-a": null,
    "conv-b": null,
  };
  const state = {
    /** The body of the next `GET /v1/conversations?limit=…` refresh. */
    page: [] as unknown[],
    probes: [] as string[],
    events,
    activeJobs,
  };

  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // The list read, distinguished from the per-conversation reads below by
    // the query string; both share the path prefix.
    if (url.includes("/v1/conversations?")) return json(state.page);

    const probe = /\/v1\/conversations\/([^/]+)\/active-job/.exec(url);
    if (probe) {
      const id = probe[1];
      state.probes.push(id);
      return json({ job_id: activeJobs[id] ?? null, status: "none" });
    }

    if (url.includes("/v1/jobs/") && url.includes("/events")) {
      await events.wait;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.includes("/v1/jobs")) {
      return json({
        job_id: "job-a",
        conversation_id: "conv-a",
        message_id: "m1",
        status: "queued",
      });
    }
    return json([]);
  };

  return { state, fetch };
}

/**
 * Park a live turn on A by switching to B mid-stream — the exact state that
 * writes the map, and the one no path ever cleared.
 */
async function parkJobOnA() {
  const s = scenario();
  const session = new ChatSession({ ...baseConfig, fetch: s.fetch });
  const manager = new StreamManager(session);

  await manager.switchTo("conv-a");
  void manager.send("start a turn on A");
  await flush();
  expect(manager.state).toBe("streaming");

  await manager.switchTo("conv-b");
  await flush();
  expect(manager.backgroundJobs.get("conv-a")).toBe("job-a");
  // The switches above probed conv-a and conv-b to restore them; only probes
  // from here on are reconciliation's.
  s.state.probes.length = 0;
  return { ...s, session, manager };
}

describe("a parked background job is reconciled against the refreshed list", () => {
  it("drops the entry when the refreshed page reports no active job", async () => {
    const { state, session, manager } = await parkJobOnA();
    const seen: StreamManagerEvent[] = [];
    manager.on((e) => seen.push(e));
    // The server now says A is idle; the page is the authoritative answer and
    // no per-conversation probe is needed for a row it carries.
    state.page = [conversationRow("conv-a", null)];

    await session.refreshConversations();

    expect(manager.backgroundJobs.has("conv-a")).toBe(false);
    expect(state.probes).toEqual([]);
    const changes = seen.filter((e) => e.type === "backgroundJobsChanged");
    expect(changes).toHaveLength(1);
    expect(
      changes[0].type === "backgroundJobsChanged" && changes[0].jobs.size,
    ).toBe(0);
  });

  it("keeps the entry when the row still names that job as live", async () => {
    const { state, session, manager } = await parkJobOnA();
    const seen: StreamManagerEvent[] = [];
    manager.on((e) => seen.push(e));
    state.page = [conversationRow("conv-a", "job-a")];

    await session.refreshConversations();

    expect(manager.backgroundJobs.get("conv-a")).toBe("job-a");
    expect(seen.some((e) => e.type === "backgroundJobsChanged")).toBe(false);
    expect(state.probes).toEqual([]);
  });

  it("drops the entry when the row names a different job", async () => {
    // The parked job is gone; a newer turn's job is what the server calls
    // live. This instance parked nothing it can rejoin.
    const { state, session, manager } = await parkJobOnA();
    state.page = [conversationRow("conv-a", "job-next")];

    await session.refreshConversations();

    expect(manager.backgroundJobs.has("conv-a")).toBe(false);
  });

  it("probes a parked conversation the page does not mention, and drops it when the job is gone", async () => {
    // A refresh reads page 1 only. A parked conversation outside it has no
    // row in hand, so the per-conversation probe — the same authority
    // `switchTo` trusts — is what answers for it.
    const { state, session, manager } = await parkJobOnA();
    state.page = [conversationRow("conv-b", null)];
    state.activeJobs["conv-a"] = null;

    await session.refreshConversations();
    await flush();

    expect(state.probes).toEqual(["conv-a"]);
    expect(manager.backgroundJobs.has("conv-a")).toBe(false);
  });

  it("keeps it when that probe still names the parked job as live", async () => {
    const { state, session, manager } = await parkJobOnA();
    state.page = [conversationRow("conv-b", null)];
    state.activeJobs["conv-a"] = "job-a";

    await session.refreshConversations();
    await flush();

    expect(state.probes).toEqual(["conv-a"]);
    expect(manager.backgroundJobs.get("conv-a")).toBe("job-a");
  });

  it("reconciles on a reconnect's re-seed too", async () => {
    // `connect()` installs an authoritative page as well; a job that ended
    // while the page was disconnected must not survive the reconnect.
    const { state, session, manager } = await parkJobOnA();
    state.page = [conversationRow("conv-a", null)];

    await session.connect();
    await flush();

    expect(manager.backgroundJobs.has("conv-a")).toBe(false);
  });
});
