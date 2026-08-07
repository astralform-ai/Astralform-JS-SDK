import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import {
  StreamManager,
  type StreamManagerEvent,
} from "../src/stream-manager.js";

/**
 * A restore that the user has moved on from must stop, not finish.
 *
 * `restore` is a chain of awaits — the active-job probe, the message list, the
 * job list, then EVERY completed turn's events in parallel. That last wave is
 * the slow one (seconds for a large conversation), and clicks are not
 * serialized, so a switch landing mid-chain is ordinary. Left to run, the
 * superseded restore called `replayTurn`, which re-points the session at the
 * conversation it is replaying and emits that conversation's whole history —
 * which the consumer rendered into the one now on screen, and which leaves
 * `send`/`regenerate` posting to a conversation the user has left.
 *
 * Each test suspends one specific await, switches away, then releases it.
 */

const baseConfig = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

/** A promise plus its resolver, for holding one endpoint open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** One completed turn's persisted events, enough to render a text block. */
const A_EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: {
      type: "message_start",
      turn_id: "t1",
      model: "m",
      job_id: "job-a",
    },
  },
  {
    seq: 1,
    event: "block_stop",
    data: {
      type: "block_stop",
      turn_id: "t1",
      job_id: "job-a",
      path: [0],
      status: "ok",
      final: { text: "A's answer" },
    },
  },
];

/**
 * A backend where conversation A's per-turn event fetch hangs on `eventsGate`.
 * Everything else answers immediately.
 */
function mockBackend(eventsGate: Promise<void>): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("/active-job")) {
      return json({ job_id: null, status: "none" });
    }
    if (url.includes("/conv-a/events")) {
      await eventsGate;
      return json(A_EVENTS);
    }
    if (url.includes("/events")) {
      return json([]);
    }
    if (url.includes("/conv-a/messages")) {
      return json([
        {
          id: "m-a",
          conversation_id: "conv-a",
          role: "user",
          content: "A's prompt",
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    if (url.includes("/conv-b/messages")) {
      return json([
        {
          id: "m-b",
          conversation_id: "conv-b",
          role: "user",
          content: "B's prompt",
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    if (url.includes("/conv-a/jobs")) {
      return json([
        { job_id: "job-a", status: "completed", message_id: "m-a" },
      ]);
    }
    if (url.includes("/jobs")) {
      return json([]);
    }
    return json([]);
  };
}

describe("a switch during a restore supersedes it", () => {
  it("does not replay the abandoned conversation into the new one", async () => {
    const events = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: mockBackend(events.wait),
    });
    const manager = new StreamManager(session);

    const seen: StreamManagerEvent[] = [];
    manager.on((e) => seen.push(e));

    // A's restore reaches the per-turn event fetch and parks there.
    const restoringA = manager.switchTo("conv-a");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The user gets bored and opens B, which settles first.
    await manager.switchTo("conv-b");

    // A's events finally arrive.
    events.open();
    await restoringA;

    // Nothing from A's transcript reached the consumer. The bug rendered it
    // all — the assistant text below, and every todo and plan event beside it
    // — into whichever conversation was displayed.
    const replayed = seen.filter((e) => e.type === "event");
    expect(replayed).toEqual([]);
    expect(seen.some((e) => e.type === "versionsReady")).toBe(false);
  });

  it("leaves the session pointing at the conversation the user chose", async () => {
    const events = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: mockBackend(events.wait),
    });
    const manager = new StreamManager(session);

    const restoringA = manager.switchTo("conv-a");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await manager.switchTo("conv-b");
    events.open();
    await restoringA;

    // `send` posts to `session.conversationId` and `regenerate` resends the
    // last user turn out of `session.messages`. A superseded `replayTurn` /
    // `loadConversation` used to set both back to A, so the next message went
    // to a conversation the user had left.
    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["B's prompt"]);
    expect(manager.activeConversationId).toBe("conv-b");
  });

  it("does not announce a state the newer switch owns", async () => {
    const events = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: mockBackend(events.wait),
    });
    const manager = new StreamManager(session);

    const restoringA = manager.switchTo("conv-a");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await manager.switchTo("conv-b");

    const after: StreamManagerEvent[] = [];
    manager.on((e) => after.push(e));
    events.open();
    await restoringA;

    // A's restore finishing must not emit anything at all — a trailing
    // `stateChange: idle` clears a consumer's restore flag mid-way through
    // B's own restore, and names B while describing A.
    expect(after).toEqual([]);
    expect(manager.state).toBe("idle");
  });

  it("restores normally when nothing supersedes it", async () => {
    // The guard must not swallow the ordinary path: same fixture, no switch.
    const events = gate();
    events.open();
    const session = new ChatSession({
      ...baseConfig,
      fetch: mockBackend(events.wait),
    });
    const manager = new StreamManager(session);

    const seen: StreamManagerEvent[] = [];
    manager.on((e) => seen.push(e));

    await manager.switchTo("conv-a");

    expect(session.conversationId).toBe("conv-a");
    expect(seen.some((e) => e.type === "versionsReady")).toBe(true);
    const texts = seen
      .filter((e) => e.type === "event")
      .map((e) => (e as { event: { type: string } }).event.type);
    expect(texts).toContain("user_message");
    expect(texts).toContain("message_start");
  });
});

describe("a switch from inside an event handler supersedes it too", () => {
  /** conv-a with TWO completed turns, so the replay loop has a second pass. */
  function twoTurnBackend(): typeof globalThis.fetch {
    const turn = (jobId: string, text: string) => [
      {
        seq: 0,
        event: "message_start",
        data: {
          type: "message_start",
          turn_id: jobId,
          model: "m",
          job_id: jobId,
        },
      },
      {
        seq: 1,
        event: "block_stop",
        data: {
          type: "block_stop",
          turn_id: jobId,
          job_id: jobId,
          path: [0],
          status: "ok",
          final: { text },
        },
      },
    ];
    return async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/active-job"))
        return json({ job_id: null, status: "none" });
      if (url.includes("job_id=job-a1")) return json(turn("job-a1", "first"));
      if (url.includes("job_id=job-a2")) return json(turn("job-a2", "second"));
      if (url.includes("/conv-a/jobs")) {
        return json([
          { job_id: "job-a1", status: "completed", message_id: "m-a1" },
          { job_id: "job-a2", status: "completed", message_id: "m-a2" },
        ]);
      }
      if (url.includes("/jobs")) return json([]);
      if (url.includes("/conv-a/messages")) {
        return json([
          {
            id: "m-a1",
            conversation_id: "conv-a",
            role: "user",
            content: "first prompt",
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: "m-a2",
            conversation_id: "conv-a",
            role: "user",
            content: "second prompt",
            created_at: "2026-01-01T00:01:00Z",
          },
        ]);
      }
      return json([]);
    };
  }

  it("stops the replay loop mid-way rather than pouring out the rest", async () => {
    // "Synchronous" bounds out awaits, not RE-ENTRANCY: `replayTurn` emits to
    // every handler, and a handler is free to drive the manager straight back.
    // Guarding only before the loop left the remaining turns streaming out
    // under the abandoned conversation's id — the same leak, through the one
    // door an await boundary does not cover. Found in review of this PR.
    const session = new ChatSession({ ...baseConfig, fetch: twoTurnBackend() });
    const manager = new StreamManager(session);

    const seen: StreamManagerEvent[] = [];
    let switched = false;
    manager.on((e) => {
      seen.push(e);
      // The consumer reacts to the first replayed event by navigating away,
      // synchronously, from inside the handler.
      if (!switched && e.type === "event") {
        switched = true;
        void manager.switchTo("conv-b");
      }
    });

    await manager.switchTo("conv-a");

    const texts = seen
      .filter((e) => e.type === "event")
      .map((e) => (e as { event: { type: string; content?: string } }).event)
      .filter((e) => e.type === "user_message")
      .map((e) => e.content);

    // The first turn's bubble had already been emitted when the handler fired;
    // the SECOND turn must not follow it.
    expect(texts).toEqual(["first prompt"]);
    expect(seen.some((e) => e.type === "versionsReady")).toBe(false);
  });

  it("does not announce versionsReady when the handler navigates on the LAST turn", async () => {
    // The loop's check runs at the TOP of each turn, so navigating away during
    // the FINAL turn leaves no iteration to catch it — the loop just ends. A
    // single-job conversation is the sharpest form: one turn, so the very
    // first replay is also the last. The two-turn test above cannot see this,
    // because its turn-2 check masks the gap. Found in review of this PR.
    const events = gate();
    events.open();
    const session = new ChatSession({
      ...baseConfig,
      fetch: mockBackend(events.wait), // conv-a has exactly one completed job
    });
    const manager = new StreamManager(session);

    const seen: StreamManagerEvent[] = [];
    let switched = false;
    manager.on((e) => {
      seen.push(e);
      if (!switched && e.type === "event") {
        switched = true;
        void manager.switchTo("conv-b");
      }
    });

    await manager.switchTo("conv-a");

    // `versionsReady` carries the abandoned conversation's id and its job
    // count — an announcement about a restore that was called off.
    expect(seen.some((e) => e.type === "versionsReady")).toBe(false);
  });

  it("still replays both turns when the handler does not navigate", async () => {
    // The control: the per-turn check must not truncate an ordinary restore.
    const session = new ChatSession({ ...baseConfig, fetch: twoTurnBackend() });
    const manager = new StreamManager(session);

    const seen: StreamManagerEvent[] = [];
    manager.on((e) => seen.push(e));

    await manager.switchTo("conv-a");

    const texts = seen
      .filter((e) => e.type === "event")
      .map((e) => (e as { event: { type: string; content?: string } }).event)
      .filter((e) => e.type === "user_message")
      .map((e) => e.content);

    expect(texts).toEqual(["first prompt", "second prompt"]);
    expect(seen.some((e) => e.type === "versionsReady")).toBe(true);
  });
});

describe("loadConversation does not install a left conversation's messages", () => {
  it("keeps the messages and the id describing the same conversation", async () => {
    // The narrower half of the same race: `loadConversation` assigns the id
    // synchronously but the messages after an await, so an in-flight call whose
    // switch has already been superseded used to overwrite the new
    // conversation's messages while the id stayed on the new one.
    const slowA = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/conv-a/messages")) {
          await slowA.wait;
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        return json([
          {
            id: "m-b",
            conversation_id: "conv-b",
            role: "user",
            content: "B's prompt",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      },
    });

    const loadingA = session.loadConversation("conv-a");
    await session.loadConversation("conv-b");
    slowA.open();
    await loadingA;

    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["B's prompt"]);
  });

  it("survives A -> B -> A, where the id is back to A when the stale fetch lands", async () => {
    // The ABA case, found in review of this PR. Comparing `this.conversationId
    // !== id` is blind to it: on the revisit the id is back to A by the time
    // A's FIRST fetch resolves, so the check passes and it clobbers the fresh
    // messages A's SECOND load already installed. Nothing upstream catches it
    // either — the stale write happens inside `loadConversation`, before
    // control returns to `restore`'s own `superseded()`. Hence a monotonic
    // token: the id says where the session IS, not which load last spoke.
    const firstA = gate();
    let aCalls = 0;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/conv-a/messages")) {
          aCalls += 1;
          const nth = aCalls;
          if (nth === 1) await firstA.wait;
          return json([
            {
              id: `m-a${nth}`,
              conversation_id: "conv-a",
              role: "user",
              content: nth === 1 ? "A stale" : "A fresh",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        return json([
          {
            id: "m-b",
            conversation_id: "conv-b",
            role: "user",
            content: "B's prompt",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      },
    });

    const staleA = session.loadConversation("conv-a"); // slow, parked
    await session.loadConversation("conv-b");
    await session.loadConversation("conv-a"); // fast, installs "A fresh"
    expect(session.messages.map((m) => m.content)).toEqual(["A fresh"]);

    firstA.open(); // the first load finally lands, with the id back on A
    await staleA;

    expect(session.conversationId).toBe("conv-a");
    expect(session.messages.map((m) => m.content)).toEqual(["A fresh"]);
  });
});
