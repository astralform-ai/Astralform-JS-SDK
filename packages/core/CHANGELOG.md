# Changelog

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
