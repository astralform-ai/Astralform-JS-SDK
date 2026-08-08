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
                  id: "m-x", // SAME id the job response returned — a real
                  // server does not invent a second one

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
              id: "m-x", // same row the job response identified
              conversation_id: "conv-b",
              role: "user",
              content: "hello",
              created_at: "2026-01-01T00:01:00Z",
            },
            {
              // The server appends TWO rows per turn. A window sized by the
              // pending count therefore never contains the user row it is
              // looking for — the reply pushes it out — so the prompt is
              // re-appended after its own answer.
              id: "m-reply",
              conversation_id: "conv-b",
              role: "assistant",
              content: "hi there",
              created_at: "2026-01-01T00:01:01Z",
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
      "hi there",
    ]);
  });
});

describe("regenerate is gated on whose messages these are", () => {
  it("stays blocked during an ordinary load, when the pointers already agree", async () => {
    // The widest instance, not an edge: `loadConversation` moves the POINTER
    // synchronously and installs the LIST when the fetch returns, so during
    // every ordinary load the two pointers agree while `messages` still holds
    // the previous conversation's turns. A pointer-equality guard passes here.
    const slowB = gate();
    const seen: { jobBody?: Record<string, unknown> } = {};
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          seen.jobBody = JSON.parse(init?.body as string);
          return json({
            job_id: "j",
            conversation_id: "x",
            message_id: "m",
            status: "queued",
          });
        }
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        if (url.includes("/conv-b/messages")) {
          await slowB.wait; // parked with the pointer ALREADY on conv-b
          return json([]);
        }
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    const switchingB = manager.switchTo("conv-b");
    await flush();

    // Both pointers agree; the messages do not.
    expect(manager.activeConversationId).toBe("conv-b");
    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);

    void manager.regenerate();
    await flush();

    // Unguarded this resends A's last message under B's id.
    expect(seen.jobBody).toBeUndefined();

    slowB.open();
    await switchingB;
  });
});

describe("relocating the conversation tears the live turn down first", () => {
  function streamingFixture() {
    const held = gate();
    const cancelled: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/cancel")) {
          cancelled.push(url);
          return json({});
        }
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait; // the turn's SSE stream never finishes on its own
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-1",
            conversation_id: "conv-a",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    return { session, manager: new StreamManager(session), held, cancelled };
  }

  it("deleteConversation cancels instead of parking a job for a gone conversation", async () => {
    // Parking is right when the user navigates away — the turn keeps running
    // and can be rejoined. Here the conversation is gone, so the entry would
    // be re-added right after being deleted: a running-job indicator on a row
    // no longer in the list, and `switchTo` forcing a full restore of it.
    const { session, manager, held, cancelled } = streamingFixture();
    await manager.switchTo("conv-a");
    void manager.send("first");
    await flush();
    expect(manager.state).toBe("streaming");

    const tagged: (string | null)[] = [];
    manager.on((e) => {
      if (e.type === "event" && e.event.type === "disconnected")
        tagged.push(e.conversationId);
    });

    await manager.deleteConversation("conv-a");
    await flush();

    // Tagged with the conversation being deleted. `session.deleteConversation`
    // nulls `conversationId` and `onSessionEvent` tags from that field, so
    // cancelling after it labels the teardown `null` — the mirror of the
    // ordering fault already fixed in `createConversation`.
    expect(tagged).toEqual(["conv-a"]);

    // The distinguishing behaviour: the job is CANCELLED, not parked. Merely
    // keeping the map clean is not enough — a detached job keeps running
    // server-side, producing output for a conversation that no longer exists.
    expect(cancelled.some((u) => u.includes("job-1"))).toBe(true);
    expect([...manager.backgroundJobs.keys()]).not.toContain("conv-a");
    expect(manager.state).toBe("idle");
    expect(session.isStreaming).toBe(false);

    held.open();
  });

  it("createConversation does not announce idle over a send that landed in its await", async () => {
    // `createNewConversation` is awaited — a real async op for any storage
    // backend other than InMemoryStorage — and a send landing inside it owns
    // the streaming state. Announcing `idle` there is the unrecoverable shape:
    // `finalizeStream` and the `message_stop` branch both no-op on a
    // non-streaming state, so it stays idle for the whole turn and the next
    // send is swallowed by `ChatSession.send`'s own `isStreaming` bail.
    const held = gate();
    const slowCreate = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/v1/jobs/") && url.includes("/events")) {
            await held.wait;
            return new Response("data: [DONE]\n\n", {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "job-1",
              conversation_id: "conv-new",
              message_id: "m1",
              status: "queued",
            });
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => {
          await slowCreate.wait; // the send lands inside this await
          return {
            id,
            title: "",
            createdAt: "",
            updatedAt: "",
            messageCount: 0,
          };
        },
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);

    // An active conversation first, or `send` would itself call
    // `createNewConversation` and block on the same gate.
    await manager.switchTo("conv-a");

    const creating = manager.createConversation();
    await flush();
    void manager.send("during the create");
    await flush();
    expect(manager.state).toBe("streaming");

    slowCreate.open();
    await creating;
    await flush();

    expect(manager.state).toBe("streaming");
    expect(session.isStreaming).toBe(true);

    held.open();
  });

  it("createConversation parks the streaming job instead of announcing idle over it", async () => {
    // Announcing `idle` while the stream lives is worse than announcing
    // nothing: `manager.send` stops bailing, calls `session.send`, and THAT
    // bails on its own `isStreaming` — the message is never posted, no error
    // is emitted, and the composer looks ready throughout.
    const { session, manager, held, cancelled } = streamingFixture();
    await manager.switchTo("conv-a");
    void manager.send("first");
    await flush();
    expect(manager.state).toBe("streaming");

    const tagged: (string | null)[] = [];
    manager.on((e) => {
      if (e.type === "event" && e.event.type === "disconnected")
        tagged.push(e.conversationId);
    });

    await manager.createConversation();

    // The teardown belongs to the OLD conversation. `createNewConversation` is
    // itself the relocation — it moves `session.conversationId` and empties
    // `messages` — and `onSessionEvent` tags from that field, so detaching
    // after it labels conv-a's teardown with the new conversation's id, before
    // `conversationChanged` has even fired.
    expect(tagged).toEqual(["conv-a"]);
    expect(manager.state).toBe("idle");
    expect(session.isStreaming).toBe(false);
    // Parked, NOT cancelled — the conversation still exists and the turn can
    // be rejoined. This is the control for the delete case above.
    expect([...manager.backgroundJobs.keys()]).toContain("conv-a");
    expect(cancelled).toEqual([]);

    held.open();
  });
});

describe("the anti-duplicate comparison is scoped to the fetch window", () => {
  it("keeps a repeat of a prompt the conversation already contains", async () => {
    // Comparing role+content against the WHOLE history drops any repeat of a
    // prompt ever said. "continue" / "yes" / "retry" are the norm in an agent
    // chat, so this is common, and the consequence is the loss the filter
    // exists to prevent. Only the newest rows can be the pending sends.
    const gated = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m",
            status: "queued",
          });
        if (url.includes("/conv-a/messages")) {
          await gated.wait;
          // The server's read happened BEFORE the new "continue" committed, so
          // the only "continue" here is the old turn-3 one.
          return json([
            {
              id: "m1",
              conversation_id: "conv-a",
              role: "user",
              content: "continue",
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              id: "m2",
              conversation_id: "conv-a",
              role: "assistant",
              content: "ok",
              created_at: "2026-01-01T00:00:01Z",
            },
          ]);
        }
        return json([]);
      },
    });

    const loading = session.loadConversation("conv-a");
    await flush();
    void session.send("continue", { conversationId: "conv-a" });
    await flush();
    gated.open();
    await loading;

    // Three: the two historical rows plus the new send.
    expect(session.messages.map((m) => m.content)).toEqual([
      "continue",
      "ok",
      "continue",
    ]);
  });
});

describe("a rejected load does not leave the old list under the new id", () => {
  it("blanks the messages instead", async () => {
    // A rejected load is not a SUPERSEDED one, so the token check lets it
    // through — while `loadConversation` has already moved the pointer. Only
    // reachable via a custom `ChatStorage` whose fallback throws, but
    // `ChatStorage` is a public interface.
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/conv-a/messages"))
            return json([
              {
                id: "m-a",
                conversation_id: "conv-a",
                role: "user",
                content: "A's prompt",
                created_at: "2026-01-01T00:00:00Z",
              },
            ]);
          if (url.includes("/conv-b/messages"))
            return new Response("nope", { status: 500 });
          return json([]);
        },
      },
      {
        // Storage fallback that throws — the path InMemoryStorage never takes.
        createConversation: async () => ({
          id: "x",
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => {
          throw new Error("storage unavailable");
        },
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );

    await session.switchConversation("conv-a");
    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);

    await session.switchConversation("conv-b");

    expect(session.conversationId).toBe("conv-b");
    expect(session.messages).toEqual([]);
  });
});

describe("a send addressed elsewhere takes the message list with it", () => {
  it("does not leave the previous conversation's turns under the new id", async () => {
    // `send(..., { conversationId })` is a documented public option. Moving the
    // pointer without the list leaves one conversation's messages under
    // another's id, and unlike a load nothing re-fetches — through
    // `StreamManager` the in-flight restore reinstalls the right list, which
    // is exactly why the manager-level tests never saw this.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-b",
            message_id: "m",
            status: "queued",
          });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);

    void session.send("hi", { conversationId: "conv-b" });
    await flush();

    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["hi"]);
    // NOT "conv-b": the list holds one turn, not that conversation's history.
    // Claiming otherwise would let `StreamManager.regenerate` — which trusts
    // this field — fire against a view missing everything before it.
    expect(session.messagesConversationId).toBeNull();
  });
});

describe("regenerate still fires when the session is settled", () => {
  it("resends the last user message — the positive control", async () => {
    // Every other regenerate test here asserts the guard BLOCKS. Without this
    // one an over-broad guard — or a `messagesConversationId` left unset on
    // some path — is a permanent silent no-op that every test still passes.
    const seen: { jobBody?: Record<string, unknown> } = {};
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          seen.jobBody = JSON.parse(init?.body as string);
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m",
            status: "queued",
          });
        }
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a1",
              conversation_id: "conv-a",
              role: "user",
              content: "the prompt to resend",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a"); // fully settled
    void manager.regenerate();
    await flush();

    expect(seen.jobBody?.resend_from).toBe("m-a1");
    expect(seen.jobBody?.message).toBe("the prompt to resend");
  });
});

describe("an addressed send that never reaches the wire puts the list back", () => {
  it("does not leave a direct caller holding nothing", async () => {
    // The relocation empties the list before anything is sent. If the send
    // fails there is no new history to replace it and nothing re-fetches.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return new Response("boom", { status: 500 });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    // `send` resolves either way — the failure surfaces as an `error` event,
    // which is why the restore keys on "was a job created", not on a throw.
    const errors: string[] = [];
    session.on((e) => {
      if (e.type === "error") errors.push(e.message);
    });
    await session.send("hi", { conversationId: "conv-b" });
    expect(errors.length).toBeGreaterThan(0);

    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);
    expect(session.conversationId).toBe("conv-a");
    expect(session.messagesConversationId).toBe("conv-a");
  });
});

describe("a load that is BOTH rejected and superseded stays out of the way", () => {
  it("does not blank the newer conversation's list", async () => {
    // Rejected and superseded are independent, and this is the case where both
    // hold. Ordering the rejection fallback before the token check lets a dead
    // call wipe the list a newer one just installed — and stamp it with the
    // wrong conversation, blocking regenerate on the live one indefinitely.
    const slowFail = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/conv-a/messages")) {
            await slowFail.wait;
            return new Response("nope", { status: 500 });
          }
          if (url.includes("/conv-b/messages"))
            return json([
              {
                id: "m-b",
                conversation_id: "conv-b",
                role: "user",
                content: "B's prompt",
                created_at: "2026-01-01T00:00:00Z",
              },
            ]);
          return json([]);
        },
      },
      {
        createConversation: async () => ({
          id: "x",
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => {
          throw new Error("storage unavailable");
        },
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );

    const failingA = session.switchConversation("conv-a"); // parked, will reject
    await flush();
    await session.loadConversation("conv-b"); // supersedes, installs B
    slowFail.open();
    await failingA;

    expect(session.conversationId).toBe("conv-b");
    expect(session.messagesConversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toEqual(["B's prompt"]);
  });
});

describe("a SUCCESSFUL addressed send keeps its relocation", () => {
  it("does not revert when the turn completes", async () => {
    // The put-back has to key on a signal that SURVIVES the turn.
    // `currentJobId` does not — `message_stop` nulls it — so after any
    // completed send it reads exactly as it did before, and the restore fires
    // on the success path: the relocation is reverted, the user message and
    // the reply are discarded, and through StreamManager the whole bug this PR
    // fixes comes back. Earlier fixtures never emitted `message_stop`, which
    // is precisely why they missed it.
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","turn_id":"t1","model":"m","job_id":"j","seq":0,"ts":0}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop","turn_id":"t1","job_id":"j","stop_reason":"end_turn","usage":{},"total_ms":1,"stall_count":0,"seq":1,"ts":0}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return new Response(sse, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-b",
            message_id: "m",
            status: "queued",
          });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    await session.send("hi", { conversationId: "conv-b" });
    await flush();

    // The relocation stands: the send succeeded, so there is nothing to undo.
    expect(session.conversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).toContain("hi");
    // Claimed, because the send SUCCEEDED: the list is a suffix of that
    // conversation rather than its whole history, but it is that
    // conversation's, and the last user turn now carries the server's own id.
    // Left null, nothing on this path would reopen the gate and `regenerate`
    // would be dead for the rest of a direct caller's session.
    expect(session.messagesConversationId).toBe("conv-b");
    expect(session.messages.map((m) => m.content)).not.toContain("A's prompt");
  });
});

describe("no path announces idle over a live stream", () => {
  it("the fast-path probe leaves a send's streaming state alone", async () => {
    // The fast path deliberately stays out of `restoring`, so the composer is
    // live for the whole probe and a send can land inside it. `send` sets
    // `streaming` without bumping the generation, so the path resumes and
    // would announce a ready composer over a running stream — after which
    // `finalizeStream` and the `message_stop` branch both no-op, and the next
    // send is silently dropped by `ChatSession.send`'s own `isStreaming` bail.
    const probe = gate();
    const held = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait; // the turn never finishes on its own
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-1",
            conversation_id: "conv-b",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/conv-b/active-job")) {
          await probe.wait; // fast path parks here, composer still live
          return json({ job_id: null, status: "none" });
        }
        if (url.includes("/conv-b/messages"))
          // NON-EMPTY, and without the just-sent turn: the server has not
          // committed it yet. An empty list here is what hid the loss.
          return json([
            {
              id: "m-hist",
              conversation_id: "conv-b",
              role: "user",
              content: "an earlier turn",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    const switching = manager.switchTo("conv-b", { skipHistoryReplay: true });
    await flush();

    void manager.send("during the probe");
    await flush();
    expect(manager.state).toBe("streaming");

    probe.open(); // the fast path resumes and would settle
    await switching;
    await flush();

    expect(manager.state).toBe("streaming");
    expect(session.isStreaming).toBe(true);

    held.open();
  });
});

describe("the put-back never rewinds a session that has moved on", () => {
  it("declines when a later load has taken ownership", async () => {
    // The last post-await mutation in the file without a supersession guard.
    // `createJob` can hang and then fail while the session moves elsewhere; an
    // unguarded put-back rewinds it to a conversation the user has left, which
    // is the very failure this change exists to prevent.
    const hangingJob = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          await hangingJob.wait;
          return new Response("boom", { status: 500 });
        }
        const which = url.includes("/conv-a/")
          ? "a"
          : url.includes("/conv-c/")
            ? "c"
            : null;
        if (which && url.includes("/messages"))
          return json([
            {
              id: `m-${which}`,
              conversation_id: `conv-${which}`,
              role: "user",
              content: `${which.toUpperCase()}'s prompt`,
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    const sending = session.send("hi", { conversationId: "conv-b" });
    await flush();
    await session.loadConversation("conv-c"); // the user moves on; this wins
    hangingJob.open();
    await sending;
    await flush();

    // conv-c is what the caller is displaying. Rewinding to conv-a here would
    // send the next unaddressed message — and `resendFromCheckpoint`, which
    // reads `conversationId` — to a conversation left two steps ago.
    expect(session.conversationId).toBe("conv-c");
    expect(session.messagesConversationId).toBe("conv-c");
    expect(session.messages.map((m) => m.content)).toEqual(["C's prompt"]);
  });
});

describe("the put-back restores each pointer from its own snapshot", () => {
  it("does not rewind conversationId to wherever the messages happened to be", async () => {
    // The two pointers are deliberately distinct — during any in-flight
    // `loadConversation` they disagree, which is the whole reason
    // `messagesConversationId` exists. Restoring one snapshot into both
    // rewinds `conversationId` to where the MESSAGES were rather than where
    // the session pointed.
    const parked = gate();
    const failJob = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          await failJob.wait;
          return new Response("boom", { status: 500 });
        }
        if (url.includes("/conv-x/messages"))
          return json([
            {
              id: "m-x",
              conversation_id: "conv-x",
              role: "user",
              content: "X's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        if (url.includes("/conv-a/messages")) {
          await parked.wait; // never lands before the assertions
          return json([]);
        }
        return json([]);
      },
    });

    await session.loadConversation("conv-x");
    void session.loadConversation("conv-a"); // pointer -> conv-a, messages still conv-x
    await flush();
    expect(session.conversationId).toBe("conv-a");
    expect(session.messagesConversationId).toBe("conv-x");

    const sending = session.send("hi", { conversationId: "conv-b" });
    await flush();
    failJob.open();
    await sending;
    await flush();

    // Each pointer goes back to its own value, not to a single shared one.
    expect(session.conversationId).toBe("conv-a");
    expect(session.messagesConversationId).toBe("conv-x");
    expect(session.messages.map((m) => m.content)).toEqual(["X's prompt"]);

    parked.open();
  });
});

describe("a handler that re-enters on conversationChanged", () => {
  it("does not hand the outer switch the inner generation", async () => {
    // `setActiveConversation` bumps and then emits synchronously. A handler
    // reacting to `conversationChanged` by switching again — routing on the
    // conversation pointer is the obvious consumer shape — bumps again before
    // a caller reading `this.generation` back could capture its own value. The
    // outer switch would then never see itself superseded, run to completion,
    // and replay the abandoned conversation's whole history.
    const slowA = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        if (url.includes("/conv-a/events")) {
          await slowA.wait;
          return json(A_EVENTS);
        }
        if (url.includes("/events")) return json([]);
        if (url.includes("/conv-a/jobs"))
          return json([
            { job_id: "job-a", status: "completed", message_id: "m-a" },
          ]);
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    let reentered = false;
    manager.on((e) => {
      if (e.type === "conversationChanged" && e.conversationId === "conv-a") {
        if (reentered) return;
        reentered = true;
        void manager.switchTo("conv-b"); // re-enter, synchronously, mid-emit
      }
    });

    const switchingA = manager.switchTo("conv-a");
    await flush();

    const replayed: string[] = [];
    manager.on((e) => {
      if (e.type === "event") replayed.push(e.event.type);
    });
    slowA.open();
    await switchingA;
    await flush();

    // conv-a was abandoned by the re-entrant switch; none of its history
    // should reach the consumer.
    expect(replayed).toEqual([]);
    expect(manager.activeConversationId).toBe("conv-b");
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

/** A turn the client will treat as finished. A bare `[DONE]` is NOT enough —
 *  a stream that ends without a terminal event is a dropped connection to the
 *  reconnect logic, which then retries until the test times out. */
function completedTurn(jobId: string): Response {
  const ev = (seq: number, event: string, data: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ seq, ts: 0, job_id: jobId, ...data })}\n\n`;
  return new Response(
    ev(0, "message_start", {
      type: "message_start",
      turn_id: "t1",
      model: "m",
    }) +
      ev(1, "message_stop", {
        type: "message_stop",
        turn_id: "t1",
        stop_reason: "end_turn",
        usage: {},
      }) +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("createConversation and deleteConversation are pointer moves too", () => {
  /** A backend whose `/conv-a/messages` parks until released. */
  function parkedA(hold: Promise<void>): typeof globalThis.fetch {
    return async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/conv-a/messages")) {
        await hold;
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

  it("createNewConversation makes an in-flight load lose", async () => {
    // Found in review of this PR. `send` bumps `loadGeneration` when it
    // relocates and says why: a pointer move IS an event a load in flight must
    // lose to. These two move the same pointers and did not. The manager's
    // `restore` bails at its next `superseded()` check, so nothing downstream
    // reports it while the session already holds A's list under the new id.
    const slowA = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: parkedA(slowA.wait),
    });

    const loadingA = session.loadConversation("conv-a");
    await flush();
    const newId = await session.createNewConversation();
    slowA.open();
    await loadingA;

    expect(session.conversationId).toBe(newId);
    expect(session.messages).toEqual([]);
    // And the pairing stays coherent, which is what keeps regenerate alive:
    // left on "conv-a", `StreamManager.regenerate` is a no-op on this
    // conversation for the rest of the session, with no path reopening it.
    expect(session.messagesConversationId).toBe(newId);
  });

  it("deleteConversation makes an in-flight load lose", async () => {
    // Worse than the create case if skipped: `session.messages` is public, so
    // the reinstalled list is the DELETED conversation's history rendered
    // under a null id.
    const slowA = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: parkedA(slowA.wait),
    });

    const loadingA = session.loadConversation("conv-a");
    await flush();
    await session.deleteConversation("conv-a");
    slowA.open();
    await loadingA;

    expect(session.conversationId).toBeNull();
    expect(session.messages).toEqual([]);
    expect(session.messagesConversationId).toBeNull();
  });
});

describe("the pending-send set stays an annotation on the message list", () => {
  /** Read the private map — a memory invariant has no public surface, and
   *  asserting the consequence instead would just restate the code. */
  function pendingSize(session: ChatSession): number {
    return (session as unknown as { pendingUserMessages: Map<string, number> })
      .pendingUserMessages.size;
  }

  it("drops the id of a send whose job never reached the wire", async () => {
    // The put-back restores the message list from its snapshot, which does not
    // contain the failed send's message — leaving its id in the set with
    // nothing behind it for the life of the session.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs"))
          return new Response("boom", { status: 500 });
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-a",
              conversation_id: "conv-a",
              role: "user",
              content: "A's prompt",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    expect(pendingSize(session)).toBe(0);

    await session.send("hi", { conversationId: "conv-b" });
    await flush();

    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);
    expect(pendingSize(session)).toBe(0);
  });

  it("drops the id of a send that never created a job at all", async () => {
    // The ordinary failure shape, and the one both put-back branches miss:
    // they are gated on `relocatedFrom`, which is null whenever the send is
    // addressed at the conversation the session is already on — which is what
    // `StreamManager` always does. Left behind, the entry sits at
    // `knownAt === 0` forever and every later load re-appends a message the
    // server never received.
    let failing = false;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs")) {
          if (failing) return new Response("boom", { status: 500 });
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        }
        if (url.includes("/conv-a/messages"))
          return json([
            {
              id: "m-server",
              conversation_id: "conv-a",
              role: "user",
              content: "landed",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    await session.send("landed"); // reconciled to "m-server"
    failing = true;
    await session.send("never sent"); // no job, no relocation

    // One, not zero: the landed turn is still legitimately pending — no
    // snapshot has confirmed it yet. Only the unsent one is gone.
    expect(pendingSize(session)).toBe(1);

    await session.loadConversation("conv-a");
    expect(
      session.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["landed"]);
    expect(pendingSize(session)).toBe(0);
  });

  it("does not accumulate ids across conversations", async () => {
    // Every `loadConversation` reached through `StreamManager` runs while the
    // list still holds the PREVIOUS conversation's messages, so the eviction
    // loop matches nothing and the set only ever grew.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            status: "queued",
          });
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    // Awaited, not fired-and-forgotten: `send` bails while a stream is live,
    // so overlapping them would leave one pending id and pass this trivially.
    for (let i = 0; i < 3; i++) await session.send(`turn ${i}`);
    await flush();
    expect(pendingSize(session)).toBe(3);

    await session.loadConversation("conv-b");

    // A's messages left the list, so their ids can never be matched again.
    expect(pendingSize(session)).toBe(0);
  });
});

describe("a row the server no longer has is not resurrected", () => {
  /**
   * `job.message_id` is proof the row exists. So a snapshot fetched AFTER that
   * proof and still missing the row means the server dropped it — and
   * re-appending then puts it back at the tail on every later load, handing
   * `regenerate` a turn the server cannot resend. A snapshot fetched BEFORE
   * the proof is just the ordinary race and must still keep it.
   */
  function backend(rows: () => unknown[]): typeof globalThis.fetch {
    return async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/jobs/") && url.includes("/events"))
        return completedTurn("j");
      if (url.includes("/v1/jobs"))
        return json({
          job_id: "j",
          conversation_id: "conv-a",
          message_id: "m-server",
          status: "queued",
        });
      if (url.includes("/conv-a/messages")) return json(rows());
      return json([]);
    };
  }

  it("drops it once a later fetch confirms its absence", async () => {
    const session = new ChatSession({
      ...baseConfig,
      fetch: backend(() => []), // the server never returns the row
    });

    await session.loadConversation("conv-a");
    await session.send("hello");
    const prompts = () =>
      session.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(prompts()).toEqual(["hello"]);

    // Issued after the job response, so this snapshot had to contain the row.
    await session.loadConversation("conv-a");
    expect(prompts()).toEqual([]);

    // ...and it stays gone, rather than reappearing on every subsequent load.
    await session.loadConversation("conv-a");
    expect(prompts()).toEqual([]);
  });

  it("keeps it when the fetch was issued before the job response", async () => {
    // The control. Without it the rule above would pass just as well by
    // dropping every pending message, which is the bug this set exists for.
    const slowFetch = gate();
    const holdJob = gate();
    let first = true;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          await holdJob.wait;
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        }
        if (url.includes("/conv-a/messages")) {
          if (first) {
            first = false;
            return json([]);
          }
          await slowFetch.wait; // issued BEFORE the job response lands
          return json([]);
        }
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    void session.send("hello");
    await flush();

    const racing = session.loadConversation("conv-a"); // snapshot predates the row
    await flush();
    holdJob.open(); // job response arrives while that fetch is still open
    await flush();
    slowFetch.open();
    await racing;

    expect(session.messages.map((m) => m.content)).toEqual(["hello"]);
  });
});

describe("the active-job branch is the same path, one probe result later", () => {
  it("leaves a send's streaming state alone when the probe finds a job", async () => {
    // The sibling of the fast-path test above, and the untested half: the
    // probe returns a NON-null job (one running in another tab, or from before
    // this instance), so instead of settling, `switchTo` falls through to
    // `restore`. There `reconnectToJob` opens with its own `isStreaming` bail
    // and returns having reconnected nothing, and the branch then announced
    // `idle` off `_state === "streaming"` — which is also what the live send
    // set. Same unrecoverable end state as the fast path: manager idle,
    // session still streaming, next send swallowed with no error.
    const probe = gate();
    const held = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/other-tab/events")) {
          // Never served: `reconnectToJob` bails before opening it.
          await held.wait;
          return json([]);
        }
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait; // the send's own turn never finishes on its own
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-1",
            conversation_id: "conv-b",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/conv-b/active-job")) {
          await probe.wait; // fast path parks here, composer still live
          return json({ job_id: "other-tab", status: "running" });
        }
        if (url.includes("/conv-b/messages")) return json([]);
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    const switching = manager.switchTo("conv-b", { skipHistoryReplay: true });
    await flush();

    void manager.send("during the probe");
    await flush();
    expect(manager.state).toBe("streaming");

    probe.open(); // resumes, finds a job, and goes through `restore`
    await switching;
    await flush();

    expect(manager.state).toBe("streaming");
    expect(session.isStreaming).toBe(true);

    held.open();
  });
});

describe("one turn does not put two messages under one id", () => {
  it("gives the assistant row its own id", async () => {
    // `job.message_id` is the PROMPT's id — the backend tags the user turn with
    // it (`HumanMessage(content=..., id=message_id)`) so a restore can pair a
    // job to its prompt by id rather than by position. It was also being used
    // as the assistant row's id here, which only became observable once
    // `consumeJobStream` started stamping the user row with it too.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    await session.send("hello");

    const ids = session.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The prompt keeps the server's id — that reconciliation is the point.
    expect(session.messages.find((m) => m.role === "user")?.id).toBe(
      "m-server",
    );
    expect(session.messages.find((m) => m.role === "assistant")?.id).not.toBe(
      "m-server",
    );
  });

  it("carries forward the prompt alone, not the prompt and its reply", async () => {
    // The consequence, and the reason a shared id is not merely untidy:
    // `pendingUserMessages` is id-keyed, so the assistant row matched as a
    // pending PROMPT and rode along with it.
    //
    // Note the snapshot must OMIT the row — with it present, both copies match
    // it by id and both filter out, which is why the obvious version of this
    // test passes against the shared id too. The case that separates them is
    // the ordinary race this set exists for: a load issued before the job
    // response, resolving against a snapshot taken before the row landed.
    const slowLoad = gate();
    const holdJob = gate();
    let firstLoad = true;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs")) {
          await holdJob.wait;
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        }
        if (url.includes("/conv-a/messages")) {
          if (firstLoad) {
            firstLoad = false;
            return json([]);
          }
          await slowLoad.wait; // issued before the job response
          return json([
            {
              id: "m-old",
              conversation_id: "conv-a",
              role: "user",
              content: "an earlier turn",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    const sending = session.send("hello");
    await flush();
    const racing = session.loadConversation("conv-a");
    await flush();
    holdJob.open();
    await sending;
    slowLoad.open();
    await racing;

    // The snapshot plus the unacknowledged PROMPT. The assistant row is local
    // and unreferenced, so it goes with the rest of the replaced list.
    expect(session.messages.map((m) => m.id)).toEqual(["m-old", "m-server"]);
  });
});

describe("deleting a conversation with a parked job tells the consumer", () => {
  it("emits backgroundJobsChanged when the deleted one was not active", async () => {
    // The `wasActive` branch argues that a job parked for a gone conversation
    // renders a running-job indicator on a conversation no longer in the list.
    // The other branch removes the same entry silently, so the consumer's last
    // snapshot keeps it and the badge survives the delete.
    const held = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait; // A's turn stays live so the switch parks it
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-a",
            conversation_id: "conv-a",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);
    const seen: StreamManagerEvent[] = [];

    await manager.switchTo("conv-a");
    void manager.send("start a turn on A");
    await flush();
    await manager.switchTo("conv-b"); // parks A's job
    await flush();
    expect(manager.backgroundJobs.has("conv-a")).toBe(true);

    manager.on((e) => seen.push(e));
    await manager.deleteConversation("conv-a"); // B is active, so not wasActive
    await flush();

    expect(manager.backgroundJobs.has("conv-a")).toBe(false);
    expect(seen.some((e) => e.type === "backgroundJobsChanged")).toBe(true);

    held.open();
  });
});

describe("delete and create lose to a switch that lands in their await", () => {
  /** Storage whose create/delete are real round-trips, as any non-memory
   *  `ChatStorage` implementation would be. */
  function slowStorage(hold: Promise<void>) {
    return {
      createConversation: async (id: string) => {
        await hold;
        return {
          id,
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        };
      },
      fetchConversations: async () => [],
      fetchMessages: async () => [],
      addMessage: async () => {},
      updateConversationTitle: async () => {},
      deleteConversation: async () => {
        await hold;
      },
    } as never;
  }

  const plainBackend: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/active-job"))
      return json({ job_id: null, status: "none" });
    return json([]);
  };

  it("deleting the active conversation does not cancel a newer switch", async () => {
    // `wasActive` is read before a real DELETE and acted on after it, so this
    // is the one relocation that is not last-writer-wins. "Delete the one I'm
    // on, then pick another from the list" is ordinary: the stale read makes
    // `setActiveConversation(null)` overwrite the newer switch AND bump the
    // generation out from under its restore, so B never restores and the user
    // clicks it again.
    const held = gate();
    const session = new ChatSession(
      { ...baseConfig, fetch: plainBackend },
      slowStorage(held.wait),
    );
    const manager = new StreamManager(session);
    const seen: StreamManagerEvent[] = [];

    await manager.switchTo("conv-a");
    manager.on((e) => seen.push(e));

    const deleting = manager.deleteConversation("conv-a");
    await flush();
    const switching = manager.switchTo("conv-b"); // lands inside the DELETE
    await flush();

    held.open();
    await deleting;
    await switching;
    await flush();

    expect(manager.activeConversationId).toBe("conv-b");
    // ...and B's own restore was allowed to finish rather than being
    // superseded by a pointer move decided before it existed.
    expect(
      seen
        .filter((e) => e.type === "conversationChanged")
        .map((e) => (e as { conversationId: string | null }).conversationId),
    ).toEqual(["conv-b"]);
  });

  it("creating a conversation does not cancel a newer switch", async () => {
    // Same shape, shorter window: `createNewConversation` is awaited, and
    // `ChatStorage` is a public interface — an IndexedDB implementation makes
    // that a real round-trip.
    const held = gate();
    const session = new ChatSession(
      { ...baseConfig, fetch: plainBackend },
      slowStorage(held.wait),
    );
    const manager = new StreamManager(session);

    const creating = manager.createConversation();
    await flush();
    const switching = manager.switchTo("conv-b"); // lands inside the create
    await flush();

    held.open();
    const created = await creating;
    await switching;
    await flush();

    expect(manager.activeConversationId).toBe("conv-b");
    // The conversation is still created and still returned — only the pointer
    // move is dropped.
    expect(created).toBeTruthy();
    // And the SESSION half agrees. Asserting only the manager is what let this
    // pass while the two disagreed: `session.createNewConversation` relocated
    // unconditionally, so the manager sat on B with the session on the new id
    // and an empty list — sticky, because `regenerate` gates on that pairing
    // and `switchTo` early-returns on B, so re-clicking it does nothing.
    expect(session.conversationId).toBe("conv-b");
    expect(session.messagesConversationId).toBe("conv-b");
  });

  it("survives a storage layer that rejects the user message", async () => {
    // On the relocation path the session is already moved and the list already
    // emptied when `storage.addMessage` runs, so an uncaught rejection escapes
    // `send` before the put-back and strands it: pointed at the target with an
    // empty list and `messagesConversationId` null — `regenerate` gated off
    // with nothing left to reopen it. `InMemoryStorage` never rejects, but
    // `ChatStorage` is a public interface.
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/v1/jobs/") && url.includes("/events"))
            return completedTurn("j");
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "j",
              conversation_id: "conv-b",
              message_id: "m-server",
              status: "queued",
            });
          if (url.includes("/conv-a/messages"))
            return json([
              {
                id: "m-a",
                conversation_id: "conv-a",
                role: "user",
                content: "A's prompt",
                created_at: "2026-01-01T00:00:00Z",
              },
            ]);
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => ({
          id,
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {
          throw new Error("storage unavailable");
        },
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );

    await session.loadConversation("conv-a");
    await session.send("hi", { conversationId: "conv-b" });

    // The relocation completed rather than throwing out of it half-done.
    expect(session.conversationId).toBe("conv-b");
    expect(session.messagesConversationId).toBe("conv-b");
  });
});

describe("a send with no conversation is inside the machinery too", () => {
  it("reconciles the id on an auto-created conversation", async () => {
    // The one branch registration used to skip: with `conversationId`
    // undefined no entry was made, so `consumeJobStream`'s reconciliation —
    // which keys off membership — could not fire, and the row kept a client id
    // the server never issued while `resendFromCheckpoint` went on to send it.
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-new",
            message_id: "m-server",
            status: "queued",
          });
        return json([]);
      },
    });

    await session.send("first ever message"); // no conversation anywhere

    expect(session.conversationId).toBe("conv-new");
    expect(session.messages.find((m) => m.role === "user")?.id).toBe(
      "m-server",
    );
  });
});

describe("the prompt survives exactly once across the commit/response window", () => {
  it("drops the snapshot's copy when the rename would collide with it", async () => {
    // The window is between the backend committing the prompt row and
    // `POST /v1/jobs` returning its id. A snapshot resolving inside it carries
    // the row under the SERVER's id while the local copy still has the
    // client's — no id to match on, so both are kept. The rename then puts two
    // rows under one id, which is the state the assistant row's own id exists
    // to prevent, and `planRestore`'s `byId` resolves to the wrong one.
    const holdJob = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events"))
          return completedTurn("j");
        if (url.includes("/v1/jobs")) {
          await holdJob.wait; // the response is still in flight
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        }
        if (url.includes("/conv-a/messages"))
          // The backend HAS committed the prompt — under its own id.
          return json([
            {
              id: "m-server",
              conversation_id: "conv-a",
              role: "user",
              content: "hello",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        return json([]);
      },
    });

    const sending = session.send("hello");
    await flush();
    await session.loadConversation("conv-a"); // resolves inside the window
    holdJob.open();
    await sending;

    const prompts = session.messages.filter((m) => m.role === "user");
    expect(prompts.map((m) => m.content)).toEqual(["hello"]);
    expect(prompts.map((m) => m.id)).toEqual(["m-server"]);
    // No two rows share an id — the property, not just this instance of it.
    const ids = session.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a send that never reached the wire leaves nothing behind", () => {
  it("removes the row a concurrent load had already merged", async () => {
    // The merge in `loadConversation` deliberately preserves an in-flight
    // send's row across a concurrent fetch — right for the success case, but
    // it is what keeps a FAILED send's row alive. Pre-PR the wholesale
    // `this.messages = …` wiped it. Left there with a client-minted id,
    // `regenerate` passes its gate and hands that id to `resend_from`.
    const slowLoad = gate();
    const failJob = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs")) {
          await failJob.wait;
          return new Response("boom", { status: 500 });
        }
        if (url.includes("/conv-a/messages")) return json([]);
        if (url.includes("/conv-b/messages")) {
          await slowLoad.wait;
          return json([
            {
              id: "m-b",
              conversation_id: "conv-b",
              role: "user",
              content: "B's history",
              created_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    const sending = session.send("never sent", { conversationId: "conv-b" });
    await flush();

    // The load resolves BEFORE the job fails, so the merge preserves the row.
    const loading = session.loadConversation("conv-b");
    await flush();
    slowLoad.open();
    await loading;
    failJob.open();
    await sending;
    await flush();

    expect(session.messages.map((m) => m.content)).toEqual(["B's history"]);
  });
});

describe("the commit proof is the turn completing, not the job response", () => {
  it("keeps a prompt the snapshot misses while the turn is still running", async () => {
    // `POST /v1/jobs` mints `message_id` and starts the loop as a BACKGROUND
    // task before returning, so the prompt row is persisted by the loop, not
    // by the handler. A fetch issued after the response can therefore
    // legitimately miss it — and reading that as "the server dropped it" would
    // discard the user's just-sent prompt and leave `regenerate` picking the
    // previous turn, the exact bug the rest of this guard closes.
    const holdStream = gate();
    const slowLoad = gate();
    let firstLoad = true;
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await holdStream.wait; // the turn has not completed
          return completedTurn("j");
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "j",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        if (url.includes("/conv-a/messages")) {
          if (firstLoad) {
            firstLoad = false;
            return json([]);
          }
          await slowLoad.wait;
          return json([]); // the loop has not committed the prompt yet
        }
        return json([]);
      },
    });

    await session.loadConversation("conv-a");
    const sending = session.send("hello");
    await flush(); // job response has landed; the turn is still streaming

    const racing = session.loadConversation("conv-a");
    await flush();
    slowLoad.open();
    await racing;

    // Kept. The job response is not proof the row exists.
    expect(
      session.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["hello"]);

    holdStream.open();
    await sending;
  });
});

describe("both halves of a create consult a counter that has actually moved", () => {
  it("does not relocate the session while the manager declines", async () => {
    // The two guards gate on different counters. `switchTo` bumps the
    // manager's `generation` synchronously but reaches `loadConversation` —
    // and so `loadGeneration` — only after the active-job probe. For that
    // whole window the manager saw itself superseded and the session did not,
    // so the create relocated the session while the manager stayed on B.
    //
    // Asserted INSIDE the window: it self-heals once B's own load runs, which
    // is why the invariant looked like it held. That made it an accident of
    // the caller's control flow rather than something the guards enforce.
    const slowCreate = gate();
    const probe = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/conv-b/active-job")) {
            await probe.wait; // B parks here, before its loadConversation
            return json({ job_id: null, status: "none" });
          }
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => {
          await slowCreate.wait;
          return {
            id,
            title: "",
            createdAt: "",
            updatedAt: "",
            messageCount: 0,
          };
        },
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);

    const creating = manager.createConversation();
    await flush();
    const switching = manager.switchTo("conv-b");
    await flush(); // B has claimed the manager's generation, parked on /active-job

    slowCreate.open();
    const created = await creating;
    await flush();

    // The manager declined its pointer move; the session must have declined
    // its own. Anything else is "manager on B, session on the new id".
    expect(manager.activeConversationId).toBe("conv-b");
    expect(session.conversationId).not.toBe(created);
    // Still null rather than "conv-b": B's `loadConversation` is what points
    // the session, and it is parked behind the probe. That lag is the whole
    // reason the two counters disagree.
    expect(session.conversationId).toBeNull();

    probe.open();
    await switching;
  });
});

describe("a send that lands in the probe window keeps its own text", () => {
  it("does not reset a live turn's accumulator from loadConversation", async () => {
    // `settleIdle` closes the ANNOUNCEMENT half of this window; the
    // `loadConversation` beside it opens with `resetStreamingState()`, which
    // nulls `currentTextPath`. The live turn's `block_start` has already gone
    // by, so every later `block_delta` fails the path check and accumulates
    // nothing — and `message_stop` persists an EMPTY assistant row and writes
    // it to storage. Pre-existing, but the fast path is the widest window
    // precisely because it leaves the composer live.
    const probe = gate();
    const afterStart = gate();
    const stored: { content?: string } = {};
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/v1/jobs/") && url.includes("/events")) {
            const ev = (seq: number, event: string, d: object) =>
              `event: ${event}\ndata: ${JSON.stringify({ seq, ts: 0, job_id: "job-1", ...d })}\n\n`;
            const enc = new TextEncoder();
            return new Response(
              new ReadableStream({
                async start(c) {
                  c.enqueue(
                    enc.encode(
                      ev(0, "message_start", {
                        type: "message_start",
                        turn_id: "t1",
                        model: "m",
                      }) +
                        ev(1, "block_start", {
                          type: "block_start",
                          turn_id: "t1",
                          path: [0],
                          kind: "text",
                        }),
                    ),
                  );
                  await afterStart.wait; // the load lands HERE, mid-turn
                  c.enqueue(
                    enc.encode(
                      ev(2, "block_delta", {
                        type: "block_delta",
                        turn_id: "t1",
                        path: [0],
                        delta: { channel: "text", text: "the answer" },
                      }) +
                        ev(3, "message_stop", {
                          type: "message_stop",
                          turn_id: "t1",
                          stop_reason: "end_turn",
                          usage: {},
                        }) +
                        "data: [DONE]\n\n",
                    ),
                  );
                  c.close();
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
              },
            );
          }
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "job-1",
              conversation_id: "conv-b",
              message_id: "m1",
              status: "queued",
            });
          if (url.includes("/conv-b/active-job")) {
            await probe.wait; // fast path parks here, composer live
            return json({ job_id: null, status: "none" });
          }
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => ({
          id,
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async (m: { role: string; content: string }) => {
          if (m.role === "assistant") stored.content = m.content;
        },
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    const switching = manager.switchTo("conv-b", { skipHistoryReplay: true });
    await flush();

    const sending = manager.send("during the probe");
    await flush(); // block_start has gone by; the turn is mid-stream

    probe.open(); // the fast path resumes and calls loadConversation
    await switching;
    await flush();

    afterStart.open(); // the rest of the turn arrives
    await sending;
    await flush();

    const assistant = session.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("the answer");
    expect(stored.content).toBe("the answer");
  });
});

describe("a rejecting storage does not strand the delete half-done", () => {
  it("announces the cancelled stream but reports the failure", async () => {
    // Two failures to avoid at once. The cancel runs BEFORE the delete and
    // records `_state = "idle"` without announcing, so letting the rejection
    // through untouched leaves the consumer's last `stateChange` at
    // `streaming` on a conversation that is neither deleted nor streaming.
    // But swallowing it reports success for a delete that did not happen —
    // `ChatSession.deleteConversation` guards only the API call, so the
    // conversation is still listed and still holds its messages.
    //
    // So: announce what actually changed, relocate nothing, and rethrow.
    const held = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/v1/jobs/") && url.includes("/events")) {
            await held.wait; // the turn stays live, so the cancel branch runs
            return new Response("data: [DONE]\n\n", {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "job-a",
              conversation_id: "conv-a",
              message_id: "m1",
              status: "queued",
            });
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => ({
          id,
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
    );
    const manager = new StreamManager(session);
    const seen: StreamManagerEvent[] = [];

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    expect(manager.state).toBe("streaming");

    manager.on((e) => seen.push(e));
    await expect(manager.deleteConversation("conv-a")).rejects.toThrow(
      "storage unavailable",
    );

    // The stream really was torn down, so that much is announced...
    expect(manager.state).toBe("idle");
    expect(
      seen.some((e) => e.type === "stateChange" && e.state === "idle"),
    ).toBe(true);
    // ...but nothing claims the conversation is gone, because it is not.
    expect(manager.activeConversationId).toBe("conv-a");
    expect(seen.some((e) => e.type === "conversationChanged")).toBe(false);

    held.open();
  });
});

describe("a restore never replays over a live turn", () => {
  it("leaves the running turn's text, job id, and state intact", async () => {
    // `send` only bails on `_state === "streaming"`, so it runs during
    // `restoring` — and nothing in it bumps `generation`, so `superseded()`
    // stays false and the replay loop runs on top of the live turn.
    // `replayTurn` reset the accumulator and each replayed `message_stop`
    // cleared `isStreaming` + `currentJobId`, so: the live turn persisted the
    // REPLAYED text, its job became uncancellable and unparkable, and the
    // manager announced idle mid-turn.
    const jobsGate = gate();
    const afterStart = gate();
    const stored: { content?: string } = {};
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          const ev = (
            seq: number,
            event: string,
            d: object,
            job = "job-live",
          ) =>
            `event: ${event}\ndata: ${JSON.stringify({ seq, ts: 0, job_id: job, ...d })}\n\n`;

          if (url.includes("/v1/jobs/job-live/events")) {
            const enc = new TextEncoder();
            return new Response(
              new ReadableStream({
                async start(c) {
                  c.enqueue(
                    enc.encode(
                      ev(0, "message_start", {
                        type: "message_start",
                        turn_id: "live",
                        model: "m",
                      }) +
                        ev(1, "block_start", {
                          type: "block_start",
                          turn_id: "live",
                          path: [0],
                          kind: "text",
                        }),
                    ),
                  );
                  await afterStart.wait; // the replay lands HERE
                  c.enqueue(
                    enc.encode(
                      ev(2, "block_delta", {
                        type: "block_delta",
                        turn_id: "live",
                        path: [0],
                        delta: { channel: "text", text: "live answer" },
                      }) +
                        ev(3, "message_stop", {
                          type: "message_stop",
                          turn_id: "live",
                          stop_reason: "end_turn",
                          usage: {},
                        }) +
                        "data: [DONE]\n\n",
                    ),
                  );
                  c.close();
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
              },
            );
          }
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "job-live",
              conversation_id: "conv-a",
              message_id: "m-live",
              status: "queued",
            });
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          if (url.includes("/conv-a/jobs")) {
            await jobsGate.wait; // restore parks here; the send lands inside
            return json([
              { job_id: "job-old", status: "completed", message_id: "m-old" },
            ]);
          }
          if (url.includes("/conv-a/messages"))
            return json([
              {
                id: "m-old",
                conversation_id: "conv-a",
                role: "user",
                content: "an earlier turn",
                created_at: "2026-01-01T00:00:00Z",
              },
            ]);
          if (url.includes("/conv-a/events"))
            // A completed turn whose own message_stop is what used to clear
            // the LIVE turn's streaming state.
            return json([
              {
                seq: 0,
                event: "message_start",
                data: {
                  type: "message_start",
                  turn_id: "old",
                  model: "m",
                  job_id: "job-old",
                },
              },
              // A text block at a DIFFERENT path from the live turn's, so a
              // replayed `block_start` that hijacked `currentTextPath` would
              // strand the live deltas with nothing matching.
              {
                seq: 1,
                event: "block_start",
                data: {
                  type: "block_start",
                  turn_id: "old",
                  job_id: "job-old",
                  path: [1],
                  kind: "text",
                },
              },
              {
                seq: 2,
                event: "block_delta",
                data: {
                  type: "block_delta",
                  turn_id: "old",
                  job_id: "job-old",
                  path: [1],
                  delta: { channel: "text", text: "old answer" },
                },
              },
              {
                seq: 3,
                event: "block_stop",
                data: {
                  type: "block_stop",
                  turn_id: "old",
                  job_id: "job-old",
                  path: [1],
                  status: "ok",
                },
              },
              // ...and a second at the SAME path the live turn is using, so a
              // replayed `block_stop` that nulled `currentTextPath` would stop
              // the live turn accumulating from that point on.
              {
                seq: 4,
                event: "block_start",
                data: {
                  type: "block_start",
                  turn_id: "old",
                  job_id: "job-old",
                  path: [0],
                  kind: "text",
                },
              },
              {
                seq: 5,
                event: "block_stop",
                data: {
                  type: "block_stop",
                  turn_id: "old",
                  job_id: "job-old",
                  path: [0],
                  status: "ok",
                },
              },
              {
                seq: 6,
                event: "message_stop",
                data: {
                  type: "message_stop",
                  turn_id: "old",
                  job_id: "job-old",
                  stop_reason: "end_turn",
                  usage: {},
                },
              },
            ]);
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => ({
          id,
          title: "",
          createdAt: "",
          updatedAt: "",
          messageCount: 0,
        }),
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async (m: { role: string; content: string }) => {
          if (m.role === "assistant") stored.content = m.content;
        },
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);
    const states: string[] = [];
    manager.on((e) => {
      if (e.type === "stateChange") states.push(e.state);
    });

    const restoring = manager.switchTo("conv-a");
    await flush(); // parked on /conv-a/jobs, state "restoring"

    const sending = manager.send("during the restore");
    await flush(); // block_start has gone by; the turn is mid-stream
    expect(session.currentJobId).toBe("job-live");

    jobsGate.open(); // the restore resumes and replays job-old
    await restoring;
    await flush();

    // The replay must not have touched the live turn.
    expect(session.currentJobId).toBe("job-live");
    expect(session.isStreaming).toBe(true);
    expect(states).not.toContain("idle");

    afterStart.open();
    await sending;
    await flush();

    const assistant = session.messages.filter((m) => m.role === "assistant");
    expect(assistant.at(-1)?.content).toBe("live answer");
    expect(stored.content).toBe("live answer");
  });
});

describe("deleting a conversation does not tear down the session", () => {
  it("keeps registered protocol adapters", async () => {
    // The cancel branch reached for `session.disconnect()`, which ends in
    // `protocols.clear()`. The SDK never auto-registers adapters — a consumer
    // wires them up after `connect()` from `agentStatus.uiComponents` — so
    // deleting one conversation silently killed embedded-resource rendering
    // for the rest of the session, with nothing short of another `connect()`
    // to bring it back. The branch only wants cancel + detach.
    const held = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait; // the turn stays live so the cancel branch runs
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-a",
            conversation_id: "conv-a",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);
    session.protocols.register({
      mimeType: "application/vnd.astralform.a2ui+json",
      render: () => null,
    } as never);

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    expect(manager.state).toBe("streaming");

    await manager.deleteConversation("conv-a");
    await flush();

    expect(session.protocols.has("application/vnd.astralform.a2ui+json")).toBe(
      true,
    );

    held.open();
  });
});

describe("the create halves agree in both directions", () => {
  it("declines the manager's move when the session declined its own", async () => {
    // The counters are not equivalent. `setActiveConversation` bumps both, so
    // a superseded manager implies a declining session — but `loadConversation`
    // bumps `loadGeneration` ALONE, so the session can decline while the
    // manager's generation is untouched, and the manager relocates over it.
    //
    // Ordinary two-click sequence: switch to A, then "New chat" while A's
    // restore is still on its probe. A's `loadConversation` fires inside the
    // storage create and bumps `loadGeneration`; the session then declines and
    // the manager, reading only its own counter, did not.
    const probe = gate();
    const slowCreate = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/conv-a/active-job")) {
            await probe.wait;
            return json({ job_id: null, status: "none" });
          }
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => {
          await slowCreate.wait;
          return {
            id,
            title: "",
            createdAt: "",
            updatedAt: "",
            messageCount: 0,
          };
        },
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);

    const restoring = manager.switchTo("conv-a");
    await flush(); // parked on A's active-job probe

    const creating = manager.createConversation();
    await flush(); // parked inside storage.createConversation

    probe.open(); // A's restore resumes → loadConversation(A) bumps loadGeneration
    await flush();

    slowCreate.open();
    const created = await creating;
    await flush();

    // The session declined, so the manager must have too.
    expect(session.conversationId).toBe("conv-a");
    expect(manager.activeConversationId).toBe("conv-a");
    expect(manager.activeConversationId).not.toBe(created);

    await restoring;
  });

  it("nulls the job id when deleting the streaming conversation", async () => {
    // `detach()` does not clear `currentJobId` and `disconnect()` did, so
    // dropping to the narrower pair left the session naming a job that was
    // just cancelled on a conversation that no longer exists.
    const held = gate();
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held.wait;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs"))
          return json({
            job_id: "job-a",
            conversation_id: "conv-a",
            message_id: "m1",
            status: "queued",
          });
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    expect(session.currentJobId).toBe("job-a");

    await manager.deleteConversation("conv-a");
    await flush();

    expect(session.currentJobId).toBeNull();

    held.open();
  });
});

describe("nothing detaches a turn without announcing it", () => {
  it("settles when the create declines after detaching", async () => {
    // `detachStreamingTurn` records `idle` silently on the contract that the
    // caller announces. The decline path returned without doing so, and the
    // decline is driven by `loadGeneration` — which the public
    // `loadConversation` moves without touching any manager state, so no
    // successor exists to cover the gap. The turn is torn down and the
    // consumer's last `stateChange` is still `streaming`.
    const held = gate();
    const slowCreate = gate();
    const session = new ChatSession(
      {
        ...baseConfig,
        fetch: async (input) => {
          const url =
            typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/v1/jobs/") && url.includes("/events")) {
            await held.wait; // the turn is live when the create starts
            return new Response("data: [DONE]\n\n", {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          if (url.includes("/v1/jobs"))
            return json({
              job_id: "job-a",
              conversation_id: "conv-a",
              message_id: "m1",
              status: "queued",
            });
          if (url.includes("/active-job"))
            return json({ job_id: null, status: "none" });
          return json([]);
        },
      },
      {
        createConversation: async (id: string) => {
          await slowCreate.wait;
          return {
            id,
            title: "",
            createdAt: "",
            updatedAt: "",
            messageCount: 0,
          };
        },
        fetchConversations: async () => [],
        fetchMessages: async () => [],
        addMessage: async () => {},
        updateConversationTitle: async () => {},
        deleteConversation: async () => {},
      } as never,
    );
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    expect(manager.state).toBe("streaming");

    const creating = manager.createConversation();
    await flush(); // detached and parked; now inside storage.createConversation

    const states: string[] = [];
    manager.on((e) => {
      if (e.type === "stateChange") states.push(e.state);
    });

    // A DIRECT session call — no manager state touched, so no successor
    // restore exists to announce on this branch's behalf.
    void session.loadConversation("conv-z");
    await flush();

    slowCreate.open();
    await creating;
    await flush();

    expect(manager.state).toBe("idle");
    expect(states).toContain("idle");

    held.open();
  });
});

describe("cancelling a turn is not a session teardown", () => {
  function streamingSession(held: Promise<void>, cancels: string[]) {
    return new ChatSession({
      ...baseConfig,
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/cancel")) {
          cancels.push(url);
          return json({});
        }
        if (url.includes("/v1/jobs/") && url.includes("/events")) {
          await held;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.includes("/v1/jobs") && init?.method === "POST")
          return json({
            job_id: "job-a",
            conversation_id: "conv-a",
            message_id: "m-server",
            status: "queued",
          });
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
  }

  it("stop() keeps registered protocol adapters", async () => {
    // `deleteConversation` was taught to avoid `disconnect()` for exactly this
    // reason; `stop()` — the path a user actually presses — still routed
    // through it, so the first Stop dropped every adapter for the session.
    const held = gate();
    const session = streamingSession(held.wait, []);
    const manager = new StreamManager(session);
    session.protocols.register({
      mimeType: "application/vnd.astralform.a2ui+json",
      render: () => null,
    } as never);

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    expect(manager.state).toBe("streaming");

    manager.stop();

    expect(session.protocols.has("application/vnd.astralform.a2ui+json")).toBe(
      true,
    );
    held.open();
  });

  it("does not leave a cancelled prompt pending forever", async () => {
    // The turn reached the wire, so the `!wire.reached` cleanup does not fire,
    // and it never reaches `message_stop`, so nothing ever stamps the entry.
    // Left at `knownAt === 0` it is re-appended by EVERY later load — the
    // phantom row the changelog claims to have closed, for the send that did
    // reach the wire and was then cancelled.
    const held = gate();
    const session = streamingSession(held.wait, []);
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    void manager.send("hello");
    await flush();

    manager.stop();
    await flush();

    // The server never committed it (a fast cancel can beat the background
    // loop's write), so a later load must not resurrect it.
    await session.loadConversation("conv-a");
    expect(
      session.messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual([]);

    await session.loadConversation("conv-a");
    expect(session.messages).toEqual([]);
    held.open();
  });

  it("cancels a parked job when its conversation is deleted", async () => {
    // The active branch cancels; the parked branch did not, so whether you
    // happened to be watching the turn when you pressed delete decided whether
    // it kept billing tokens for output with nowhere to land.
    const held = gate();
    const cancels: string[] = [];
    const session = streamingSession(held.wait, cancels);
    const manager = new StreamManager(session);

    await manager.switchTo("conv-a");
    void manager.send("start a turn");
    await flush();
    await manager.switchTo("conv-b"); // parks A's job
    await flush();
    expect(manager.backgroundJobs.get("conv-a")).toBe("job-a");
    cancels.length = 0;

    await manager.deleteConversation("conv-a"); // B is active — the parked branch
    await flush();

    expect(cancels.some((u) => u.includes("job-a"))).toBe(true);
    held.open();
  });
});

describe("a restore superseded on entry does nothing at all", () => {
  it("neither announces nor probes for the abandoned conversation", async () => {
    // `setActiveConversation` emits `conversationChanged` synchronously, and a
    // consumer routing on the pointer calls `switchTo` from inside it — the
    // door `setActiveConversation` returns its claimed generation to close.
    // The outer restore then resumed and announced `restoring` tagged with the
    // NEWER conversation's id, and burned a `getActiveJob` round-trip for one
    // nobody was waiting on, before its first check finally bailed.
    const urls: string[] = [];
    const session = new ChatSession({
      ...baseConfig,
      fetch: async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        urls.push(url);
        if (url.includes("/active-job"))
          return json({ job_id: null, status: "none" });
        return json([]);
      },
    });
    const manager = new StreamManager(session);

    let reentered = false;
    manager.on((e) => {
      if (e.type === "conversationChanged" && e.conversationId === "conv-a") {
        if (reentered) return;
        reentered = true;
        void manager.switchTo("conv-b"); // synchronous re-entry
      }
    });

    await manager.switchTo("conv-a");
    await flush();

    expect(reentered).toBe(true);
    expect(manager.activeConversationId).toBe("conv-b");
    // A's restore was superseded before it ran: no probe for it at all.
    expect(urls.filter((u) => u.includes("/conv-a/active-job"))).toEqual([]);
  });
});
