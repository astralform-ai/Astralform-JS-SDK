# Changelog

## 7.1.0

### Added

- **`ModelOption.iconUrl`, `lastUsedAt` and `useCount`** — the provider's brand mark, and the calling user's recency/usage for that model, from `GET /v1/models`. Together they are what a picker needs to render provider tiles and a "Recent" section whose ordering matches every other client, since the backend owns it rather than each device keeping its own history.
- **`ModelOption.contextWindow`** — the model's context window in tokens as the serving provider reports it, which is not always the model's headline number.

All four are optional, and `getModels()` normalizes them to `null` when the backend omits them, so "no data" is a single value. (`thinkingControl` is deliberately excluded from that treatment — its absence is itself the "no control to render" signal.)

These fields have existed on `GET /v1/models` for some time; only the typed accessors are new. A consumer that worked around their absence by reading `/v1/models` raw can now delete that code and use `getModels()` — which is worth doing, because a hand-written mapper forwards the fields its author knew about and silently drops the rest. That is the same failure `getModels()` itself had before 7.0.0.

## 7.0.0

### Changed — BREAKING

**`ModelOption.thinkingMode` and `ModelOption.supportsEffort` are removed, replaced by `thinkingControl`.**

A model's thinking control is a per-model LADDER, not a fixed `low | medium | high`. Probing the providers showed the real vocabulary is seven values — `none / minimal / low / medium / high / xhigh / max`, verbatim what OpenAI, DeepSeek and Z.AI each enumerate when rejecting an invalid effort — and that a given model accepts a subset. `gpt-5.x` has no `minimal` or `max`; xAI rejects `max`; Z.AI cannot be turned off at all.

```ts
// before — the Off had to be synthesized, and the levels were a guess
if (model.supportsEffort) {
  const off = model.thinkingMode === "controllable" ? ["off"] : [];
  const options = [...off, "low", "medium", "high"];
}

// after
if (model.thinkingControl) {
  const options = model.thinkingControl.ladder;   // ordered, already correct
}
```

- **`thinkingControl` absent** is the signal to render no control. That replaces `supportsEffort`, which had to be kept consistent with the level list beside it.
- **`ladder` is ordered least-effort-first.** A rung's INDEX is its strength, which is what a proportional indicator should read.
- **`label` is server-owned**, so two clients cannot word the same rung differently.
- **`default` is nullable** — for the OpenAI-style family the server sends no effort at all, so the choice belongs to the provider and naming a rung would be a guess.
- **An Off is an ordinary `none` rung**, present iff the model can genuinely stop reasoning. Clients no longer synthesize one from a mode string. Note that `"none"` (an explicit request not to think) is distinct from omitting the effort (use the model's default), and on some models those differ.

`ReasoningEffort` is widened to `EffortRung`. New exported types: `EffortRung`, `ThinkingDescriptor`, `ThinkingRungOption`.

Requires a backend with `thinking_control` on `GET /v1/models` (astralform-ai/Astralform#867).

### Fixed

**`getModels()` no longer drops fields the API adds.** It hand-mapped a fixed list of keys, so anything not named was silently discarded — the server emitted a per-model `effort_levels` for months that no consumer could see. It now maps structurally, and a regression test pins that an unrecognized field survives.

### Added

- `TeamAgentSummary.displayName` — the human-readable picker label (`display_name` on the wire), now surfaced by `listAgents()`. Optional and null-safe; consumers should fall back to `name`. The backend started returning this on `GET /v1/teams/{team_id}/agents` in [astralform-ai/Astralform#848](https://github.com/astralform-ai/Astralform/pull/848).

## 6.0.3

### Fixed

**A turn that FAILED now restores what the agent did, instead of disappearing.**
6.0.2 fixed the half of this that renders the user's PROMPT when no turn
survived to anchor it. The turn's own content was still missing: restore fetched
per-job events only for jobs whose status was `completed`, so a failed job was
never asked for and everything it did vanished on reload — the tool calls, their
output, and the terminal `error` that explains why it stopped. A conversation
whose only job failed came back showing the prompt and nothing else.

Nothing was missing server-side. A job that died on an agent-loop timeout still
had 4,220 events persisted, and the history endpoint returned a complete
47-event stream for it, terminal error included. The client simply never asked
for them.

Status was the wrong axis. What decides whether a job belongs in the events wave
is where its events COME FROM — the live stream for the one being reconnected
to, storage for every other — and how a turn ended says nothing about that. The
replay set is now every job except the one arriving live.

`versionsReady` deliberately stays narrower and still counts completed jobs
only: it drives version navigation, and a version is an answer the user can
switch to, which a failed turn did not produce.

## 6.0.2

### Fixed

**Reopening a conversation whose turn did not COMPLETE now restores the
transcript.** 6.0.1 covered a turn that is still running and resolved by the
active-job probe. It did not cover the same conversation a minute later, once
that turn had ended without completing — so the original report recurred
against the fixed build, this time with a cancelled video generation: the
turn's blocks under no prompt at all.

Jobs are the spine of the walk, and the positional fallback maps over JOBS. A
failed or cancelled job is not `completed`, so it never reaches the completed
set; if it was the only one, the walk is empty and the plan came back empty
with it, dropping every prompt the conversation had. The message list is the
only record that those turns happened, so an empty walk now emits its prompts
on their own rather than losing them with the jobs that would have anchored
them.

This also covers a turn that is still running but which the active-job probe
did not resolve — the liveness key can expire while the job row has not — where
the prompt is claimed by a job that anchors nothing. The claim set exists to
stop a prompt being drawn twice, once by its turn and once as a steer, so it is
ignored for a walk that emits no turn at all.

## 6.0.1

### Fixed

**Reopening a conversation while a turn is still running now restores the
transcript.** It previously rendered that turn's blocks under nothing at all —
no prompt, and no earlier history either — because the live path reconnected to
the running job's event stream and skipped the history replay entirely. A user
prompt is not in `job_events`; it lives in the messages table, so the reconnect
had nothing to render it from.

Nothing about it was specific to any one tool. It was a function of turn
DURATION: the window is open for as long as the turn runs, so a long tool call
(a video generation holds one block open for minutes) made it reachable by
simply switching conversations and coming back. It healed once the turn ended,
which is why history looked correct at rest and empty only mid-flight.

History now replays on both paths. The running turn is paired with the prompt
that started it and emitted before the reconnect, so the bubble sits above the
agent header the live stream opens. The job being reconnected to is excluded
from the history fetch, leaving the live stream as its single source.

### Changed

**`versionsReady` now fires when a conversation is restored over a running
turn**, which it never did before — the event was only reachable on the
settled path. The count is unchanged in meaning: completed jobs only, since a
running turn is not a version yet.

## 6.0.0

### BREAKING CHANGES

**`session.deleteConversation` now rejects when the delete failed.** It
previously caught every error from the API call and dropped the conversation
locally regardless, so a failed delete was indistinguishable from a successful
one: the row left the list, survived on the server, and reappeared on the next
device or the next reload.

A **404 still resolves** — the backend 404s a conversation that is already
gone, and that is this delete succeeding. Everything else — 403, 401, 429, 5xx,
or the request never landing — now rejects *before* the local drop, leaving the
conversation in `session.conversations` and in storage.

Major, because a caller doing a bare `await session.deleteConversation(id)`
turns a silent no-op into an unhandled rejection on upgrade. Wrap it:

```ts
try {
  await session.deleteConversation(id);
} catch (err) {
  // The conversation is still there — say so instead of hiding the row.
}
```

### Added

**`ServerError.status`** — the HTTP status, when the error came from a
response. Every status except 401 and 429 collapses into `ServerError`, so
telling "already gone" (404) from "the server broke" (500) or "not yours" (403)
previously meant parsing the message. `undefined` for a `ServerError`
constructed without a response.

## 5.1.0

### Added

**`ConversationAsset.posterUrl`** — a signed still to render for an asset that
cannot be its own thumbnail. Video only: an `<img src>` pointed at an mp4 draws
nothing, because a poster frame costs a container decode, so a video row had no
thumbnail to show at all. The backend resolves it from the image a generated
clip was animated from — that still is literally the clip's first frame.
Undefined for everything else, and for a clip with no recorded source (one
assembled in a sandbox rather than by `generate_video`).

**`ConversationAsset.contentUrl`** — the asset's permanent address. It never
expires, because authorization is resolved per request against the caller's
live session rather than frozen into a signature; store and link this one.
It needs an `Authorization` header, which a browser will not attach to an
`<img src>`, so keep rendering from `url`.

`contentUrl` is not a new API field — the backend has served `content_url` for
several releases. `mapAsset` is an allowlist and silently dropped it, so every
consumer saw `undefined`, including one that had declared the field in a local
type widening and therefore type-checked against a value that never arrived.
Nothing breaks on upgrade; a consumer that worked around the gap can stop.

## 5.0.0

### BREAKING CHANGES

**`send({ conversationId })` now relocates the session instead of addressing one turn.**

Previously it posted a turn to another conversation and left the session where it
was. It now sets `session.conversationId`, **discards `session.messages`**, and
invalidates any `loadConversation` still in flight. A direct `ChatSession`
consumer using the old semantics — send a turn to a side conversation, keep
rendering the current one — loses its message list on upgrade, with no error.

The old behaviour was not safe to keep: `onSessionEvent` tags every emitted
event with `session.conversationId`, so leaving the pointer behind filed the
send's OWN stream events under the conversation the caller had just addressed
away from, and `regenerate` resent a list belonging to a different conversation
than the one `send` posts to.

**Migration** — if you need the target's history after the send:

```ts
await session.send(text, { conversationId: id });
await session.loadConversation(id);
```

Callers going through `StreamManager` are unaffected **in the settled case**:
it passes its own active conversation, which normally already matches. The two
pointers deliberately diverge during a restore's active-job probe — the manager
moves the moment the user clicks, `session.conversationId` only when that
switch's own `loadConversation` runs — and a send landing in that window does
relocate. The restore reinstalls the right list a moment later, so the end
state is fine, but a consumer reading `session.messages` or
`session.messagesConversationId` directly sees the gap.

**TypeScript will not catch this for you.** The `SendOptions` exported from the
package is `StreamManager`'s, which has no `conversationId`; the one that does
is internal. So an affected caller is passing an inline object literal to
`ChatSession.send`, and gets no error on upgrade — this entry is the only
signal.

**Assistant message ids are now client-generated.** `job.message_id` is the
PROMPT's id; the assistant row was being pushed under it too. The user turn now
carries it — which is what lets a restore pair a job to its prompt by id rather
than by position — and the assistant row gets a local id until a REST load
replaces it. A consumer keying rendered state off `message.id` for assistant
rows will see a different value across the live → restored boundary; key off
position or the block path instead.

### Fixed

**A conversation switch the user has moved on from now stops instead of
finishing.** `restore` is a chain of awaits — the active-job probe, the message
list, the job list, then every completed turn's events in parallel — and clicks
are not serialized. A superseded restore ran to completion, re-pointed the
session at the conversation being replayed, and poured its whole history out of
the event stream into the one on screen. A monotonic generation, claimed
synchronously by `setActiveConversation` and checked at every await boundary and
per-turn inside the replay loop, ends it at the first check after the switch.

Fixed along the same seam:

- **Status, plan, and note documents no longer follow the user between
  conversations.** Together with `@astralform/chat`'s per-conversation document
  buckets, this is the client half of a status panel binding to the wrong
  conversation.
- **`createConversation` and `deleteConversation` invalidate a load in flight.**
  Both move `conversationId`, so a fetch landing afterwards used to reinstall
  the previous conversation's list under the new id — and because `regenerate`
  gates on that pairing, nothing reopened it for the rest of the session.
- **A restore no longer announces an idle composer over a live send.** On both
  the fast path and the active-job branch, a send landing during the probe kept
  the composer readable as ready for the whole turn, after which the next send
  was swallowed by `ChatSession.send`'s own `isStreaming` bail with no error.
- **A completed turn no longer puts two messages under one id.** `job.message_id`
  is the PROMPT's id; the assistant row was being pushed under it too. The user
  turn now carries it — which is what lets a restore pair a job to its prompt by
  id rather than by position — and the assistant row gets its own.
- **A send that never reached the wire no longer leaves its row behind.**
  Previously the local user row stayed in `session.messages` with
  `status: "complete"` — a claim it had no business making — and `regenerate`
  would pick it and resend under a client-minted id the server never issued.
  A consumer that rendered the failed message and expected it to persist should
  read the `error` event instead.
- **Pressing Stop no longer wipes the protocol registry.** `stop()` routed
  through `session.disconnect()`, which ends in `protocols.clear()` — so the
  first Stop dropped every registered `ProtocolAdapter` for the rest of the
  session, and the SDK never re-registers them. Stop now cancels the TURN
  (`session.cancelTurn()`), leaving the session's own state alone. Deleting a
  conversation takes the same path, and a parked background job on a deleted
  conversation is now cancelled rather than left billing tokens.
- **A cancelled turn no longer strands its prompt.** A turn that reached the
  wire and was then stopped never reaches `message_stop`, so nothing could
  prove its prompt committed and every later load re-appended the row.
  Cancelling now hands authority back to the server.
- **Deleting a conversation with a parked background job emits
  `backgroundJobsChanged`,** so a running-job badge cannot outlive the
  conversation it points at.

## 4.9.1

**A dropped SSE stream can no longer hang a turn forever.** A dead HTTP/3 (QUIC) connection leaves `reader.read()` pending indefinitely — no bytes, no error, no FIN. The existing reconnect loop only engages on a *rejected* or *cleanly closed* stream, so it never fired: the turn sat on "working" with no recovery path and no way for a client to tell it apart from a slow model. Seen in production as `ERR_QUIC_PROTOCOL_ERROR` on `/v1/jobs/{id}/events`.

`pumpStream` now runs a stall watchdog. The backend emits a keepalive every 15s, so a healthy stream never goes quiet for long; if no event arrives for **45s** the stream is treated as a zombie, the connection is aborted, and a `ConnectionError` feeds the existing reconnect-from-`lastSeq` loop. Recovery is transparent — the turn resumes from the last seq and completes.

Two things worth knowing if you tune this:

- **It depends on the keepalive's framing, not just its interval.** The backend sends `keepalive` as a typed wire event, so it reaches the SSE parser as a real `data:` line and resets the timer. A bare `: keepalive` SSE *comment* would be swallowed by the parser and the watchdog would fire on every healthy turn that thinks for 45s.
- **Time-to-give-up is now ~5.5 min, not ~17s.** The 17.5s figure is the backoff sum (0.5+1+2+4+5+5). A stalled attempt burns 45s before it even registers as a failure, so all 7 attempts stalling is 7 × 45s + 17.5s. That is deliberate: a stalled stream is indistinguishable from a slow one until the watchdog fires, and a shorter window would kill healthy long-running turns.

Also fixed: `disconnect()` / `detach()` during reconnect backoff could let one more `/events` request go out. The per-attempt `AbortController` is linked to the session signal by an `abort` *listener*, and a signal aborted while the loop was sleeping has already dispatched that event — so the listener never fired and the fresh controller stayed live. That attempt reached the network, emitted `ChatEvent`s to lingering handlers, and could run a client tool on a session the caller believed was gone. The loop now bails up front when the signal is already aborted, restoring the short-circuit that passing the outer signal straight to `fetch` used to provide.

## 4.9.0

**A turn can now be put in video mode.** The backend has accepted `video_mode` on `POST /v1/jobs` since Astralform 0.67.0, but `send()` builds the request body field by field — so a client passing `videoMode` had it silently dropped, ran an ordinary turn, and waited for a clip nobody had requested. There was nothing on the wire to explain why.

- `SendOptions.videoMode` on both `ChatSession` and `StreamManager`, mapped to `video_mode`.
- Mutually exclusive with `imageMode` at the composer level — which is why a video turn also gets the image tool server-side: the user cannot select both, so the agent must be able to produce its own first frame.

`generate_video` animates an **existing** image; it cannot start from text, and the clip is silent.

**Which backend you need, precisely** — `video_mode` being accepted is not the same as a clip arriving:

| Needs | Backend |
|---|---|
| `video_mode` accepted on `POST /v1/jobs` | ≥ 0.67.0 |
| A clip that actually completes | **> 0.67.0** — a ~232 s generation cannot cross Cloudflare's ~126 s origin timeout, so on 0.67.0 it fails with a 524. Fixed by the submit+poll transport, unreleased at time of writing. |
| `AgentStatus.capabilities` reporting `video`, to gate the affordance | **> 0.67.0** — also unreleased at time of writing. |

Gate on the capability the same way image mode does. Until a backend carrying it ships, the key is simply absent, which reads as hidden — so a client written against this is correct now and lights up on its own when the backend catches up.

## 4.8.0

**The plan and notes a conversation accumulates now reach the client live.** The backend has emitted `plan_update` and `note_update` since the plan/note tools shipped, but `translateCustomEvent` dropped both at `default: return null` — so a client could only learn about a plan by polling REST. Combined with a poll that is skipped mid-stream, a plan written at minute 1 of a 13-minute turn stayed invisible until the turn ended.

- `plan_update` → `{ type: "plan_update"; plan: string }` — the full markdown body, not a diff, because `write_plan` replaces the document wholesale.
- `note_update` → `{ type: "note_update"; notes: string[] }` — names only; bodies are unbounded and read on demand.
- `PlanUpdatePayload` / `NoteUpdatePayload` exported alongside the other custom-event payloads.

Both default rather than drop on an empty payload: a plan can legitimately be cleared, and dropping that event would leave a panel showing a plan that no longer exists.

## 4.7.0

**A conversation can now be renamed — previously its title was whatever the server generated from the first turn, permanently.** There was no way to change it from any client; the SDK's `updateConversationTitle` is local-cache-only and makes no network call.

- `ChatSession.renameConversation(id, title)` / `StreamManager.renameConversation(id, title)` — rename a conversation and update the entry the sidebar reads.
- `AstralformClient.renameConversation(id, title)` — the REST call, returning the updated `Conversation`.
- `AstralformClient.patch<T>(path, body)` — public raw verb, alongside the existing `get` / `post`.

**Requires a backend with `PATCH /v1/conversations/{id}`.**

The server deliberately does **not** bump `updated_at` for a rename: the list is ordered `updated_at DESC`, and relabelling a conversation is not activity — bumping it would fling a months-old conversation to the top of the user's history. `renameConversation` therefore merges the server's row rather than stamping its own timestamp, and consumers should do the same.

The write is server-first rather than optimistic, unlike `deleteConversation`. A failed delete is self-correcting — the row is still there on the next page fetch — but nothing refetches a conversation already in the loaded list, so a locally-applied title the server rejected would survive until a full reload. The title stored is the server's, not the caller's, since the server trims before persisting.

## 4.6.1

**`imageMode` did not reach the wire through `StreamManager.send()` — the path every consumer actually uses.** 4.6.0 added the option to `ChatSession.SendOptions` and mapped it in `session.ts`, but `StreamManager` has its **own** `SendOptions` and re-maps field by field into the session. Neither line existed there, so `manager.send(content, { imageMode: true })` did not typecheck, and would have sent an ordinary turn if it had.

- `SendOptions.imageMode` in `stream-manager.ts`, forwarded to `session.send`.
- Test asserts on the **request body** through `manager.send()`, so a missing line in either mapper fails it. 4.6.0's tests only exercised `ChatSession` directly and passed while the consumer path was broken.

`imageMode` now appears in the same four places `planMode` does — both option interfaces and both mappers. That symmetry is the thing to check when adding another send option.

## 4.6.0

**A client could learn an agent has image generation but had no way to ask for it.** 4.5.0 forwarded `AgentStatus.capabilities`, so a UI could finally tell whether to offer image generation — but `send()` mapped its options field by field and had no image flag, so the request went out as an ordinary turn. The backend attaches the image tool *only* on a turn that asks for it, so the agent had nothing to call and the affordance did nothing.

- `SendOptions.imageMode` → `image_mode` on the job request. Needs Astralform ≥ 0.59.0, where the backend began accepting the field.
- Off by default and per-message: generating costs the developer real money at a third-party provider, so the agent does not get to decide on its own that a picture would be nice. An unset flag is omitted from the body rather than sent as `false`.

Gate the affordance on `AgentStatus.capabilities` (4.5.0) — an agent with no provider configured has no tool to call even with `imageMode: true`.

## 4.5.0

**The agent's capability list never reached consumers.** The backend reports which capabilities an agent actually has — so a client can offer image generation only where a provider is configured, rather than rendering a control that fails on send — but `getAgentStatus()` mapped the response field by field and `capabilities` was not one of them. The field was dropped in the mapper, which downstream is indistinguishable from the agent not having the capability at all.

- `AgentStatus.capabilities: AgentCapability[]` — `{ key, enabled }`, exported as `AgentCapability`. Needs Astralform ≥ 0.61.0; older servers omit the field.
- Defaults to `[]`, never `undefined`, so a caller can iterate without a guard and a server predating the field reads as *reports nothing* rather than throwing.
- Entries with no usable `key` are dropped and `enabled` is coerced. `""` counts as no key: a capability with no name cannot be matched against and would render as an unlabelled row.

Treat an **absent key as "not reported", never as disabled.** The backend only reports capabilities with a real per-agent gate — always-on ones are deliberately omitted, since a constant tells a client nothing. A consumer that reads a missing key as `false` will hide a working feature on any server that does not report it.

## 4.4.0

**Restoring a conversation paired each turn with the wrong prompt whenever a mid-run steer was involved.** `StreamManager.restore` matched the N-th completed job to the N-th user message, which is only sound while every user message starts exactly one job. A steer (`POST /conversations/{id}/steer`) starts none, so it shifted every later turn onto the prompt before it and pushed the last one off the end of the loop — and the steer's own bubble was never rendered at all.

- Turns now pair by `job.message_id`, the id the backend stamps on the prompt that started the job (needs Astralform ≥ 0.59.0; older jobs report `null` and fall back to the positional walk unchanged).
- A user message no job claims is a steer: it replays as its own bubble, positioned where it was sent rather than dropped.
- A job with no visible prompt is a goal continuation — its seed is hidden from the message list — and replays its events in place with no bubble, which is what the positional version did by accident when it ran off the end.
- `user_message` events now carry `id` and, for a replayed steer, `steer: true`; `ChatSession.replayTurn` takes an optional `userMessageId` and `isSteer`. Without the marker a replayed steer is indistinguishable from an ordinary prompt, so a consumer that also appends pending steers on restore would render the message twice.

Conversations predating the link keep the old behaviour, including its flaw. No backfill is possible: inferring which historic prompt started which job is the exact ambiguity the link removes, so guessing would write the bug into the data.

## 4.3.0

**The conversation list can now be paged — previously it could not be, and history past the first page was unreachable.** `connect()` fetched exactly one page of 50 and nothing ever requested a second, so a user with more than 50 conversations simply could not see the older ones from the SDK's `conversations` array.

- `ChatSession.loadMoreConversations()` — appends the next page and returns only what it actually added. Resolves `[]` when there is nothing more or a load is already in flight; rejects on network failure with `hasMoreConversations` left true so the caller can retry.
- `ChatSession.hasMoreConversations` / `isLoadingConversations` — state for rendering an infinite-scroll sentinel.
- `CONVERSATION_PAGE_SIZE` (50) exported; `connect()` and `loadMoreConversations()` share it.

A page request in flight when the paging state changes underneath it — `connect()` re-seeding the list, or `deleteConversation` removing a server-sourced row — is discarded via a paging generation token. Applying it would append the wrong rows on top of the fresh page-1 state — leaving a page-sized hole — and leave the offset too high, so every later request re-fetched the same offset and paging never advanced again. In both cases the offset was computed before the change but the server evaluates the query after it, so the response starts at the wrong row. The invalidation is tied to the offset actually moving: a `connect()` whose own list fetch fails, or a delete of a purely local conversation, leaves it intact and the in-flight page still applies.

**Known limitation:** offset paging is only stable while the already-consumed prefix is. Perturbations this session causes are corrected for, but one it never observes — a not-yet-loaded conversation bumped to the top by a routine or another device, or a conversation deleted from another tab — shifts the prefix underneath the offset and costs at most one conversation off the list until the next `connect()`, which re-seeds page 1 and recovers it. Nothing is lost server-side. Both cases are pinned by tests. Closing the gap needs keyset paging on `(updated_at, id)` server-side; tracking ids client-side cannot discover a row that moved into a region already scanned.

The offset is derived from the ids the **server** has returned, not from `conversations.length`. The array is also mutated locally — `createNewConversation` and the auto-created conversation in `consumeJobStream` both unshift — so a length-based offset would request the next page one row too far and silently drop a conversation. For the same reason `deleteConversation` now pulls the offset back one when it removes a server-sourced conversation, since deleting shifts every later page up by one. Conversations re-served in a later page (the list is `updated_at DESC`, so a bumped conversation can appear twice) are deduped rather than appended twice.

## 4.2.0

**REST requests now have a deadline.** A response whose headers arrived but whose body stalled used to hang forever: `json()` ran outside every error guard, and no request carried an `AbortSignal`. A stalled `getMessages` could park `StreamManager.restore()` before it ever fetched the `/jobs` + `/events` it renders from, leaving the conversation stuck on an empty view with no error and no retry.

- New `timeoutMs` config option (default `30_000`) on both auth modes. One deadline covers connect, headers, **and** the body read; on expiry the request aborts (freeing the socket) and rejects with `ConnectionError`. The deadline is enforced by a race, so it holds even for an injected `fetch` that ignores the signal.
- Does **not** apply to `uploadFile` (large files on slow uplinks) or to SSE streaming, which is long-lived by design and carries its own `AbortSignal`.

## 4.1.0

- Add `goal` to `ChatStreamRequest` for goal mode.

## 4.0.0

**Breaking: `enableSearch` / `enable_search` removed — requires a backend with always-on search (Astralform >= 0.32).** Search is no longer a per-request client decision: when the agent's search feature is enabled server-side, the search tools are always available and the agent decides per-task whether to use them.

- `SendOptions.enableSearch` (session and stream-manager variants) removed.
- `ChatStreamRequest.enable_search` removed from the wire type.
- `ChatSession.resendFromCheckpoint` no longer takes an options argument (its only option was `enableSearch`).

**History restore is now near-instant.** Restoring a completed conversation no longer re-types itself:

- The backend restore endpoint (Astralform >= 0.32) strips live-only token deltas, so `GET /v1/conversations/{id}/events` returns the collapsed block stream (~1/45th the rows on a busy chat). Restore rebuilds each block from its `block_stop` final, which was always the reducer's source of truth.
- `StreamManager.restore` fetches the message list **once** (was once per turn) and each turn's events **in parallel** (was serial), then replays them **synchronously** so the consumer batches the whole conversation into a single render instead of one per event.
- `StreamManager.switchTo(id, { skipHistoryReplay })` — new opt-in fast path for consumers that cache a restored conversation's rendered blocks. It moves the active pointer and loads the message list but skips the event fetch + replay and never enters the `restoring` state, so re-opening a conversation you've already viewed is instant. It still confirms via `getActiveJob` that no job is live before skipping — so a job left running across a page reload or in another tab is still reconnected — making the flag safe to pass whenever you hold cached blocks.
- `ChatSession.replayTurn(id, events, userMessageContent?)` — new low-level primitive that synchronously replays already-fetched events (the StreamManager uses it to replay each turn). `ChatSession.switchConversation(id, jobId?)` is retained as the documented convenience that fetches messages + events and replays.

## 3.2.0

- Add `ModelOption.supportsEffort` — whether the model accepts a configurable reasoning effort.

## 3.1.0

**Client-side model selection.** Chat clients can now choose the model, reasoning effort, and temperature per turn. Additive — omit them and the server reuses the conversation's last model or a connected-provider default.

- `ChatStreamRequest` and `SendOptions` gain `provider` / `model` / `reasoning_effort` (`reasoningEffort` on the camelCase options) / `temperature`, deduped via a shared `ModelChoiceOptions`.
- New `client.getModels()` → `GET /v1/models`, returning `ModelOption[]` (the team's connected-provider catalog).
- `ChatSession.send` / `StreamManager.send` throw when only one of `provider` / `model` is supplied.

## 3.0.0

**Breaking: wire rename — requires backend >= 0.16.0.** The remaining legacy wire names from the project → agent rename are cut. No JS API changes, but the wire behavior breaks against older backends, hence the major:

- Agent scoping header: `X-Project-ID` → `X-Agent-ID`
- Readiness route: `getAgentStatus()` now calls `/v1/agent/status` (was `/v1/project/status`)

2.0.x continues to work only against backends that still serve the old wire names (< 0.16.0); the hosted platform cut over with backend 0.16.0.

## 2.0.0

**Breaking: project → agent rename.** Astralform no longer has a project level — the hierarchy is account → team → **agents**. The SDK surface renames accordingly, with no deprecated aliases (clean cut, matching backend `0.14.0+` which serves `GET /v1/teams/{team_id}/agents` only):

| 1.x | 2.0 |
|-----|-----|
| `listProjects(teamId)` | `listAgents(teamId)` |
| `ProjectSummary` | `TeamAgentSummary` |
| `projectId` (config option + getter) | `agentId` |
| `updateProjectId(id)` | `updateAgentId(id)` |
| `getProjectStatus()` | `getAgentStatus()` |
| `ProjectStatus` | `AgentStatus` |
| `session.projectStatus` | `session.agentStatus` |

Wire compatibility: the HTTP surface the SDK speaks is unchanged except discovery — `listAgents()` calls `/v1/teams/{team_id}/agents` (the 1.x `/projects` path no longer exists on the backend, which is why 1.x's picker flow 404s). `X-Project-ID` and `/v1/project/status` remain the wire names for agent scoping/readiness until a coordinated protocol rename.

Migration: mechanical find/replace of the identifiers above; no behavior changes.

## 1.0.0

First stable release. Promotes the 0.2.x preview surface to a stable v1 contract: typed wire protocol, typed `ChatEvent` union, and a user-token auth mode for apps that act on behalf of an Astralform account holder (AstralChat and future 3rd-party integrations).

Because the 0.2.x line exposed an unstable preview, this version does include breaking shape changes relative to 0.2.3. Read the migration notes below before upgrading from 0.2.x.

**Note on scope.** This SDK is a product client, not an auth orchestrator. It accepts pre-obtained tokens (API keys or OIDC access tokens) and sends them with requests — it does not generate authorization URLs, handle OAuth redirect callbacks, or manage PKCE. Apps that want to drive the Astralform Identity Provider's authorization-code flow (e.g., AstralChat) own that code in their own codebase. If a consumer needs to obtain a token, they redirect users to `auth.astralform.ai/login` themselves.

### Two authentication modes

`AstralformConfig` is now a discriminated union — pick the mode that matches the caller:

```ts
// API-key mode (customer backends, B2B2C — unchanged behavior):
new AstralformClient({ apiKey: "sk_live_...", userId: "<end-user-id>" });

// User-token mode (apps acting on behalf of an Astralform account holder):
new AstralformClient({ accessToken: "<OIDC access token>", projectId: "<project>" });
```

Header shape per mode:

| Mode | `Authorization` | Identity header |
|------|-----------------|-----------------|
| API-key | `Bearer sk_...` | `X-End-User-ID` |
| User-token | `Bearer <JWT>` | `X-Project-ID` |

New instance methods on user-token clients:

- `client.updateAccessToken(token)` — hot-swap after a refresh, no reconstruction needed.
- `client.updateProjectId(projectId)` — switch project context; backend re-verifies access on the next request.
- `client.updateEndUserId(id)` — set or clear an optional end-user override (sent as `X-End-User-ID`). Lets a developer acting under a user token impersonate a downstream end-user for testing — memory, rate limits, and conversations scope against the specified end-user rather than the developer themselves. Pass `null` or an empty string to clear.
- `client.endUserId` — read the current override (`null` when unset).
- `client.authMode` — `"api_key" | "user_token"` introspection.

New `AstralformUserTokenConfig.endUserId?: string` — optional constructor-time override for the same behavior.

New type exports: `AstralformApiKeyConfig`, `AstralformUserTokenConfig`.

### New client methods

Catches up with backend endpoints that were missing from the SDK:

- `client.getJob(jobId)` — fetch `JobStatus` (status, timestamps, token counts, error message) without replaying the SSE stream.
- `client.submitFeedback(jobId, { rating, comment })` — send thumbs-up/down (`1` or `-1`) on a completed job. Returns `FeedbackResponse`.
- `client.getActiveJob(conversationId)` — promoted from `StreamManager` internals; returns `{ jobId, status }`.
- `client.listJobs(conversationId)` — promoted from `StreamManager` internals; returns a chronological list of `JobSummary` (includes `replacesJobId`, `metrics`, `responseContent`) for version navigation.
- `client.listTeams()` — account-scoped discovery route for user-token mode. Returns `TeamSummary[]` (id, name, slug, isDefault, role). Works without a `projectId` set; callers use this after OIDC login before the user has picked a team.
- `client.listProjects(teamId)` — list the caller's projects within a given team. Returns `ProjectSummary[]`. Same "pre-pick" mode semantics as `listTeams()`.

### New typed `ChatEvent`s

Five wire events that previously fell through to `{ type: "custom" }` (or were dropped entirely) are now typed:

- `tool_approval_granted` — `{ toolName, callId }`. Emitted when the user approves a HITL tool call.
- `tool_permission_denied` — `{ toolName, callId, reason, deniedBy }`. Emitted when a hook/rule/circuit-breaker denies a tool. `deniedBy` values include `"hook" | "rule" | "user" | "timeout" | "circuit_breaker"`.
- `tool_harness_warning` — `{ toolName, callId, message, details }`. Harness-layer warnings (e.g. output truncation).
- `user_unavailable` — `{ consecutiveTimeouts, toolName }`. Emitted when the HITL circuit breaker auto-denies after repeated approval timeouts.
- `prompt_suggestion` — `{ suggestions: string[] }`. The backend emits this via the legacy transport path (not wrapped in a `custom` envelope); the SDK now coerces it into the typed `ChatEvent` union.

Also adds matching `ChatEventType` constants and exports the new payload interfaces from `custom-events.ts`.

### Removed `ChatEvent` types

- **`complete`** — the SDK no longer synthesises a completion event. `message_stop` is the terminal turn event. Field map:
  - `complete.content` → accumulate `block_delta(channel="text")` yourself (or read `session.messages` after `message_stop`).
  - `complete.conversationId` → `session.conversationId`.
  - `complete.title` → the `title_generated` custom event.
  - `complete.metrics` → `message_stop.usage` + `message_stop.totalMs` + `message_stop.ttfbMs`.
  - `complete.jobId` → `message_stop.jobId` (now required, camelCase only — the `job_id` alias is gone).
- **`tool_call`** — removed. The SDK still handles the client-tool round-trip internally; observers should watch the wire events:
  - Tool requested: `block_start` with `kind: "tool_use"`.
  - Tool ready to execute: `block_stop` with `status: "awaiting_client_result"`. Payload is on `block_stop.final` (`call_id`, `tool_name`, `input`).
  - Approval required: `tool_approval_requested` custom event.

### Changed `error` event shape

Before: `{ type: "error"; error: Error }` (could be `RateLimitError` when the backend sent a rate-limit SSE error).

After: `{ type: "error"; code: string; message: string; blockPath: number[] | null }`.

`RateLimitError` / `AuthenticationError` / `ServerError` are still thrown from HTTP calls (`connect()`, `submitToolResult`, `submitToolApproval`, etc.). They are no longer wrapped in an SSE `error` event — consumers that did `event.error instanceof RateLimitError` should instead check `event.code === "rate_limit_exceeded"`.

### Reshaped `TodoItem`

```ts
// Before
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  id?: string;
}

// After
interface TodoItem {
  id: number; // required, numeric
  subject: string; // renamed from `content`
  status: "pending" | "in_progress" | "completed" | "deleted";
  description?: string | null;
  activeForm?: string | null;
  owner?: string | null;
  blockedBy?: number[] | null;
  blocks?: number[] | null;
  priority?: number | null;
}
```

Rename `content` → `subject` and treat `id` as a required number when reading `todo_update.todos`.

### New required field on `ProjectStatus`

`ProjectStatus.uiComponents: { enabled: boolean; protocol: string | null; mimeType: string | null }` — populated from the backend's `ui_components` block. Defaults to `{ enabled: false, protocol: null, mimeType: null }` when the backend omits it.

### New typed custom events

The `custom` passthrough is still emitted for unknown names, but these ten now have first-class typed variants on `ChatEvent`:

`subagent_start`, `subagent_stop`, `context_warning`, `memory_recall`, `memory_update`, `desktop_stream`, `attachment_staged`, `workspace_ready`, `asset_created`, `tool_approval_requested`, `state_changed`.

### New public APIs

- `session.protocols` — a `ProtocolRegistry` for registering framework-specific renderers keyed by MIME type. Lifecycle is tied to the session (cleared on `disconnect()`). Gate registration on `session.projectStatus?.uiComponents.protocol`.
- `parseEmbeddedResource(value)` / `isEmbeddedResource(value)` — detect MCP-style embedded resources in tool output.
- `client.submitToolApproval({ job_id, call_id, decision, scope })` — respond to `tool_approval_requested` events.
- `session.send(msg, { planMode: true })` — new request option.
- `translateDelta`, `mapSseToChat`, `replayEvents`, `RawSseEvent` — now exported from the package root for consumers that replay persisted `job_events`.

### New wire event fields

- `message_start`: `agent_display_name`.
- `message_stop`: `job_id` (was optional; now required on the `ChatEvent` as `jobId: string`).
- `retry`: `strategy`, `max_attempts`, `context_recovery`.
- `block_delta(status)`: new status value `"awaiting_approval"`.

### Minimum runtime

Node 18+, ES2022 target. No change from 1.x.
