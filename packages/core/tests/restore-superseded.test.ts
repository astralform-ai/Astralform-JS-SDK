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

describe("a send during the probe window goes to the displayed conversation", () => {
  /**
   * The narrowest window, found in review of this PR. The generation guards
   * stop the superseded restore, but `session.conversationId` is assigned
   * synchronously by `loadConversation` and only re-assigned when the NEXT
   * switch reaches its own `loadConversation` — an await later, behind the
   * active-job probe. In between, the manager points at B while the session
   * still points at A, and `send`/`regenerate` are the two things that read
   * the session's pointer.
   *
   * Interleaving: park A on its `/messages` fetch and B on its `/active-job`
   * probe, then release A. A's restore stops (superseded), but the session is
   * left on A while the user is looking at B.
   */
  function racedBackend(
    slowAMessages: Promise<void>,
    slowBActiveJob: Promise<void>,
    seen: { jobBody?: Record<string, unknown> },
  ): typeof globalThis.fetch {
    return async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/jobs")) {
        seen.jobBody = JSON.parse(init?.body as string);
        return json({
          job_id: "job-x",
          conversation_id: seen.jobBody?.conversation_id,
          message_id: "m-x",
          status: "queued",
        });
      }
      if (url.includes("/conv-b/active-job")) {
        await slowBActiveJob; // B parks here, before its loadConversation
        return json({ job_id: null, status: "none" });
      }
      if (url.includes("/conv-b/messages")) {
        // A REAL server round-trips the POSTed message back under its OWN id.
        // The earlier fixture returned a static empty list, which is what let a
        // duplicate-on-revisit bug pass its tests — see the merge in
        // `loadConversation`.
        return json(
          seen.jobBody
            ? [
                {
                  id: "m-server-hello",
                  conversation_id: "conv-b",
                  role: "user",
                  content: seen.jobBody.message,
                  created_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (url.includes("/active-job"))
        return json({ job_id: null, status: "none" });
      if (url.includes("/conv-a/messages")) {
        await slowAMessages; // A parks here, having already set conversationId
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
      return json([]);
    };
  }

  /** Drive both switches into the window, then release A. */
  async function enterWindow() {
    const slowA = gate();
    const slowB = gate();
    const seen: { jobBody?: Record<string, unknown> } = {};
    const session = new ChatSession({
      ...baseConfig,
      fetch: racedBackend(slowA.wait, slowB.wait, seen),
    });
    const manager = new StreamManager(session);

    const restoringA = manager.switchTo("conv-a");
    await flush(); // A reaches loadConversation("conv-a") and parks on /messages
    const restoringB = manager.switchTo("conv-b"); // parks on /active-job
    await flush();

    slowA.open();
    await restoringA;
    await flush();

    // The window, exactly as described: manager on B, session still on A.
    expect(manager.activeConversationId).toBe("conv-b");
    expect(session.conversationId).toBe("conv-a");
    expect(manager.state).toBe("restoring");

    return { manager, session, seen, slowB, restoringB };
  }

  it("posts to the manager's conversation, not the session's stale one", async () => {
    const { manager, session, seen, slowB, restoringB } = await enterWindow();

    // Not awaited: `send` goes on to consume the job's SSE stream, which this
    // fixture does not serve. The POST is what this pins.
    void manager.send("hello");
    await flush();

    // `send` only bails on "streaming", so it runs here — and without an
    // explicit address it would post to `session.conversationId` ("conv-a"),
    // the conversation the user just left.
    expect(seen.jobBody?.conversation_id).toBe("conv-b");

    slowB.open();
    await restoringB;

    // ...and after B's own restore settles the message is present EXACTLY
    // once. Losing it and duplicating it are both failures: B's fetch was
    // issued after the POST, so the server's copy is authoritative and the
    // local one must not be carried forward beside it under a client id the
    // server never assigned.
    expect(session.messages.map((m) => m.content)).toEqual(["hello"]);
    expect(session.conversationId).toBe("conv-b");
  });

  it("does not regenerate against a half-settled session", async () => {
    const { manager, seen, slowB, restoringB } = await enterWindow();

    void manager.regenerate();
    await flush();

    // Nothing posted: the message id would have come from the previous
    // conversation's list, which pairs with no conversation coherently.
    expect(seen.jobBody).toBeUndefined();

    slowB.open();
    await restoringB;
  });
});

describe("the skipHistoryReplay fast path has the same window at idle", () => {
  it("does not regenerate while the session still points at the old conversation", async () => {
    // The fast path deliberately never enters `restoring` — that is its whole
    // point, so a consumer with cached blocks sees no spinner. So a guard
    // written as `state === "restoring"` never fires here, and the window is
    // just as open at `idle`. This is why the guard asks whether the session
    // has caught up, rather than which state the manager is in.
    const slowBProbe = gate();
    const seen: { jobBody?: Record<string, unknown> } = {};
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          seen.jobBody = JSON.parse(init?.body as string);
          return json({
            job_id: "job-x",
            conversation_id: "x",
            message_id: "m-x",
            status: "queued",
          });
        }
        if (url.includes("/conv-b/active-job")) {
          await slowBProbe.wait; // fast path parks here, BEFORE its loadConversation
          return json({ job_id: null, status: "none" });
        }
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
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
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a"); // settles: session and manager both on A
    expect(session.conversationId).toBe("conv-a");

    const switchingB = manager.switchTo("conv-b", { skipHistoryReplay: true });
    await flush();

    // The window — note the state is `idle`, not `restoring`.
    expect(manager.activeConversationId).toBe("conv-b");
    expect(session.conversationId).toBe("conv-a");
    expect(manager.state).toBe("idle");

    void manager.regenerate();
    await flush();

    // Nothing posted. Unguarded, this resends A's last user message — and the
    // manager would call it conversation B.
    expect(seen.jobBody).toBeUndefined();

    slowBProbe.open();
    await switchingB;
  });
});

describe("switchConversation carries the same guard as loadConversation", () => {
  it("survives A -> B -> A, the same ABA the direct load handles", async () => {
    // `switchConversation` is the direct-ChatSession API (the manager does not
    // call it) and had its own copy of the messages assignment — so its own
    // copy of the ABA bug. Found by auditing every reader of `this.messages`
    // rather than waiting for it to be reported: same defect, one function
    // away. It now loads through `loadConversation`, so there is one guard.
    const firstA = gate();
    let aCalls = 0;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/events")) return json([]);
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
        return json([]);
      },
    });

    const staleA = session.switchConversation("conv-a"); // slow, parked
    await session.switchConversation("conv-b");
    await session.switchConversation("conv-a"); // fast, installs "A fresh"
    expect(session.messages.map((m) => m.content)).toEqual(["A fresh"]);

    firstA.open();
    await staleA;

    expect(session.messages.map((m) => m.content)).toEqual(["A fresh"]);
  });
});

describe("a generation-bumping origin settles the state itself", () => {
  async function parkedRestore() {
    const msgs = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        if (url.includes("/conv-a/messages")) {
          await msgs.wait; // A's restore parks here
          return json([]);
        }
        if (url.includes("/conversations") && !url.includes("/"))
          return json([]);
        return json([]);
      },
    });
    const manager = new StreamManager(session);
    const restoringA = manager.switchTo("conv-a");
    await flush();
    expect(manager.state).toBe("restoring");
    return { manager, msgs, restoringA };
  }

  it("createConversation clears a restoring state it superseded", async () => {
    // Widening the generation bump to every pointer move means a superseded
    // restore returns WITHOUT emitting — so an origin that has no successor
    // restore to announce for it must announce itself, or `_state` sits at
    // `restoring` forever on a brand-new empty conversation and a consumer's
    // spinner never clears.
    const { manager, msgs, restoringA } = await parkedRestore();

    await manager.createConversation();
    msgs.open();
    await restoringA;

    expect(manager.state).toBe("idle");
  });

  it("deleteConversation of the active conversation does the same", async () => {
    const { manager, msgs, restoringA } = await parkedRestore();

    await manager.deleteConversation("conv-a");
    msgs.open();
    await restoringA;

    expect(manager.state).toBe("idle");
  });
});

describe("switchConversation does not replay a conversation the caller left", () => {
  it("stops on plain A -> B, not just the A -> B -> A the merge covers", async () => {
    // The messages half was guarded first; `replayTurn` was still called
    // unconditionally, and it both re-points the session and emits the turn.
    // A -> B -> A ends on A either way, so only plain A -> B exposes it.
    const slowA = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/conv-a/events")) {
          await slowA.wait;
          return json(A_EVENTS);
        }
        if (url.includes("/events")) return json([]);
        return json([]);
      },
    });

    const staleA = session.switchConversation("conv-a");
    await flush();
    await session.switchConversation("conv-b");

    const seen: string[] = [];
    session.on((e) => seen.push(e.type));
    slowA.open();
    await staleA;

    expect(session.conversationId).toBe("conv-b");
    expect(seen).toEqual([]);
  });
});

describe("a send that MOVES the pointer invalidates a load in flight", () => {
  it("does not let the abandoned snapshot land under the new conversation", async () => {
    // Same probe window, releases in the other order: the send happens while
    // A's message fetch is STILL open. Without the bump, A's snapshot passes
    // its own token check (nothing else bumped) and installs A's list under
    // B's id — one conversation's messages under another's — and the just-sent
    // message is filtered out by the conversation predicate and lost.
    const slowAMessages = gate();
    const slowBProbe = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-x",
            conversation_id: "conv-b",
            message_id: "m-x",
            status: "queued",
          });
        if (url.includes("/conv-b/active-job")) {
          await slowBProbe.wait;
          return json({ job_id: null, status: "none" });
        }
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        if (url.includes("/conv-a/messages")) {
          await slowAMessages.wait; // still open when the send happens
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
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    const switchingA = manager.switchTo("conv-a");
    await flush();
    const switchingB = manager.switchTo("conv-b");
    await flush();

    void manager.send("hello");
    await flush();

    slowAMessages.open(); // A's snapshot lands AFTER the send moved the pointer
    await switchingA;
    await flush();

    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["hello"]);

    slowBProbe.open();
    await switchingB;
  });

  it("leaves a load for the conversation being sent to alone", async () => {
    // The other half of the rule, and the reason the bump is conditional:
    // re-stating the current conversation is not a move, so a load for THAT
    // conversation must still win — otherwise sending while its history is
    // arriving would discard the history.
    const gated = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-x",
            conversation_id: "conv-b",
            message_id: "m-x",
            status: "queued",
          });
        if (url.includes("/conv-b/messages")) {
          await gated.wait;
          // The server has ALREADY persisted the send by the time it answers.
          return json([
            {
              id: "m-history",
              conversation_id: "conv-b",
              role: "user",
              content: "earlier turn",
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "m-server-hello",
              conversation_id: "conv-b",
              role: "user",
              content: "hello",
              created_at: "2026-01-01T00:01:00Z",
            },
          ]);
        }
        return json([]);
      },
    });

    const loading = session.loadConversation("conv-b");
    await flush();
    void session.send("hello", { conversationId: "conv-b" });
    await flush();
    gated.open();
    await loading;

    // History kept, and "hello" appears ONCE — the local copy carries a client
    // id the server never assigned, so keeping it beside the server's row is a
    // duplicate that `regenerate` would then resend from an unknown checkpoint.
    expect(session.messages.map((m) => m.content)).toEqual([
      "earlier turn",
      "hello",
    ]);
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
