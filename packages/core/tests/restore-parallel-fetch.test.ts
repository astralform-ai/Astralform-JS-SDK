import { describe, it, expect } from "vitest";
import { ChatSession } from "../src/session.js";
import { StreamManager } from "../src/stream-manager.js";

/**
 * The three requests a restore opens with are independent — fire them together.
 *
 * `restore` needs the active-job probe, the message list and the job list
 * before it can plan a replay, and none of the three is an input to another:
 * they are all addressed by `conversationId` alone. Issued serially, their
 * round trips add up (~0.4 s each from a real client), and any one that stalls
 * blocks the two behind it. Issued together, the restore waits for the slowest
 * rather than the sum.
 *
 * Both halves are asserted here, because either alone is satisfiable by a
 * regression: that the requests OVERLAP (the point of the change), and that
 * the results are still consumed in the order the replay needs (the thing that
 * makes overlapping them safe).
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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

const MESSAGES = [
  {
    id: "m-1",
    conversation_id: "conv-a",
    role: "user",
    content: "A's prompt",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const JOBS = [{ job_id: "job-1", status: "completed", message_id: "m-1" }];

const EVENTS = [
  {
    seq: 0,
    event: "message_start",
    data: { type: "message_start", turn_id: "t1", model: "m", job_id: "job-1" },
  },
  {
    seq: 1,
    event: "block_stop",
    data: {
      type: "block_stop",
      turn_id: "t1",
      job_id: "job-1",
      path: [0],
      status: "ok",
      final: { text: "A's answer" },
    },
  },
];

/** Which of the three opening requests a URL is, or null for anything else. */
function classify(url: string): "probe" | "messages" | "jobs" | null {
  if (url.includes("/active-job")) return "probe";
  if (url.includes("/events")) return null;
  if (url.includes("/messages")) return "messages";
  if (url.includes("/jobs")) return "jobs";
  return null;
}

/**
 * A backend that records the order requests are ISSUED in and holds all three
 * opening requests behind one gate.
 *
 * Held open on purpose: it is the only way to tell a parallel wave from a fast
 * serial chain. While the gate is shut nothing can resolve, so a serial
 * implementation cannot get past its first request — whatever has been issued
 * by then is exactly what was issued without waiting for anything.
 */
function recordingBackend(openingGate: Promise<void>): {
  fetch: typeof globalThis.fetch;
  issued: string[];
} {
  const issued: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const kind = classify(url);
    if (kind) {
      issued.push(kind);
      await openingGate;
    }
    if (kind === "probe") return json({ job_id: null, status: "none" });
    if (kind === "messages") return json(MESSAGES);
    if (kind === "jobs") return json(JOBS);
    if (url.includes("/events")) return json(EVENTS);
    return json([]);
  };
  return { fetch, issued };
}

describe("a restore opens its three independent requests together", () => {
  it("issues the probe, the messages and the job list without waiting for each other", async () => {
    const opening = gate();
    const backend = recordingBackend(opening.wait);
    const session = new ChatSession({ ...baseConfig, fetch: backend.fetch });
    const manager = new StreamManager(session);

    const restoring = manager.switchTo("conv-a");
    // Nothing has been answered yet, so anything issued by now was issued
    // without waiting on anything.
    await flush();

    expect([...backend.issued].sort()).toEqual(["jobs", "messages", "probe"]);

    opening.open();
    await restoring;
    await flush();
  });

  it("still replays the turn, so overlapping the fetches did not break the plan", async () => {
    const opening = gate();
    const backend = recordingBackend(opening.wait);
    const session = new ChatSession({ ...baseConfig, fetch: backend.fetch });
    const manager = new StreamManager(session);

    const blocks: string[] = [];
    manager.on((e) => {
      if (e.type === "restoredBlock" || e.type === "blockStop") {
        const text = (e as { block?: { text?: string } }).block?.text;
        if (text) blocks.push(text);
      }
    });

    const restoring = manager.switchTo("conv-a");
    await flush();
    opening.open();
    await restoring;
    await flush();

    // The message list is installed and the conversation is the one asked for:
    // `loadConversation` still lands before anything reads `session.messages`.
    expect(session.conversationId).toBe("conv-a");
    expect(session.messages.map((m) => m.content)).toEqual(["A's prompt"]);
    expect(manager.state).toBe("idle");
  });
});
