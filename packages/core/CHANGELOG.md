# Changelog

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
