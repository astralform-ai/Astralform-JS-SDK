// =============================================================================
// Event replay — translate persisted wire events into ChatEvent sequences
//
// The backend persists wire events in the `job_events` table. When a
// consumer needs to restore a conversation (page refresh, conversation
// switch), it fetches these raw events and replays them through the same
// ChatEvent pipeline used during live streaming.
//
// All wire → ChatEvent translation lives in `translate.ts`. This file just
// adapts the persisted envelope shape (`{seq, event, data}`) and handles
// user-message interleaving, which the backend doesn't record.
// =============================================================================

import { translateWireEvent } from "./translate.js";
import type { ChatEvent, WireEvent } from "./types.js";

/**
 * Raw SSE event shape returned by GET /v1/conversations/{id}/events.
 * Mirrors what JobEventWriter persists to the job_events table.
 */
export interface RawSseEvent {
  seq: number;
  event: string;
  data: Record<string, unknown>;
  /** Epoch ms when the event was persisted (from job_events.created_at). */
  created_at?: number;
}

/**
 * Build a ``WireEvent`` from the persisted envelope. The data payload is
 * authoritative (and always carries ``type`` in practice); the SSE event
 * name is a fallback for older rows that pre-date the v2 protocol.
 */
function toWireEvent(raw: RawSseEvent): WireEvent | null {
  const type = (raw.data.type as string) || raw.event;
  if (!type || type === "done") return null;
  return { ...raw.data, type } as unknown as WireEvent;
}

/**
 * Map a raw SSE event (persisted in job_events) into the SDK ChatEvent
 * format. Returns an array because some rows (malformed / ``done`` sentinels)
 * map to zero events.
 */
export function mapSseToChat(raw: RawSseEvent): ChatEvent[] {
  const wire = toWireEvent(raw);
  if (!wire) return [];
  const event = translateWireEvent(wire);
  return event ? [event] : [];
}

/**
 * Replay persisted SSE events through the provided handler, interleaving
 * user messages from session.messages at the first message_start of each
 * turn (user messages aren't persisted in job_events).
 */
export function replayEvents(
  sseEvents: RawSseEvent[],
  userMessages: { role: string; content: string }[],
  handleEvent: (event: ChatEvent) => void,
  addBlock: (block: { type: "user"; id: string; content: string }) => void,
): void {
  const userMsgs = userMessages.filter((m) => m.role === "user");
  let userIdx = 0;
  let expectingUserMessage = true;

  for (const raw of sseEvents) {
    const type = (raw.data.type as string) || raw.event;

    if (type === "message_stop") {
      expectingUserMessage = true;
    }

    if (
      type === "message_start" &&
      expectingUserMessage &&
      userIdx < userMsgs.length
    ) {
      const userMsg = userMsgs[userIdx]!;
      addBlock({
        type: "user",
        id: `replay_user_${userIdx}`,
        content: userMsg.content,
      });
      userIdx++;
      expectingUserMessage = false;
    }

    for (const ce of mapSseToChat(raw)) {
      handleEvent(ce);
    }
  }
}
