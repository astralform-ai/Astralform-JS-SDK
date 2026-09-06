import { AuthenticationError, ConnectionError, ServerError } from "./errors.js";
import { createRateLimitErrorFromHttp } from "./rate-limit.js";
import { streamJobSSE } from "./streaming.js";
import { VOICE_POLISH_MODES, isVoicePolishMode } from "./types.js";
import { camelizeKeys, sanitizeErrorText } from "./utils.js";
import type {
  ActiveJob,
  AgentInfo,
  AgentStatus,
  AstralformApiKeyConfig,
  AstralformConfig,
  AvailableRepositories,
  ChatStreamEvent,
  ChatStreamRequest,
  CodeProject,
  Conversation,
  ConversationAsset,
  ConversationEvent,
  FeedbackRequest,
  FeedbackResponse,
  JobCreateResponse,
  JobStatus,
  JobSummary,
  Message,
  ModelOption,
  MyToolGrantsPage,
  SkillInfo,
  SlashCommand,
  SlashCommandSurface,
  TeamAgentSummary,
  TeamSummary,
  ToolApprovalRequest,
  ToolCallRequest,
  ToolOutputMode,
  ToolOutputStub,
  ToolResultRequest,
  ToolSource,
  VoiceConfig,
  VoicePolishEvent,
  VoicePolishRequest,
  VoiceTranscribeOptions,
  VoiceTranscript,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.astralform.ai";
const DEFAULT_TIMEOUT_MS = 30_000;

function validateBaseURL(url: string): string {
  const cleaned = url.replace(/\/+$/, "");
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(
        `Invalid baseURL protocol "${parsed.protocol}" - only http: and https: are allowed`,
      );
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch (err) {
    if (err instanceof Error && err.message.includes("Invalid baseURL")) {
      throw err;
    }
    throw new Error(`Invalid baseURL: "${cleaned}" is not a valid URL`);
  }
}

function isApiKeyConfig(
  config: AstralformConfig,
): config is AstralformApiKeyConfig {
  return "apiKey" in config;
}

/** Discriminates between the two auth modes the client supports. */
type AuthMode =
  | { kind: "api_key"; apiKey: string; userId: string }
  | {
      kind: "user_token";
      accessToken: string;
      /** Null until the user picks an agent; account-scoped calls still work. */
      agentId: string | null;
      /** Optional end-user override. When present, sent as X-End-User-ID. */
      endUserId: string | null;
    };

/** The message row as the REST API sends it. */
interface RawToolCall {
  call_id: string;
  tool_name: string;
  display_name?: string;
  description?: string;
  arguments?: Record<string, unknown>;
  is_client_tool?: boolean;
  tool_category?: string;
  icon_url?: string;
}

/** A source as the WIRE spells it. Coincides with `ToolSource` today only
 *  because every key is a single word; a `published_at` added server-side
 *  would otherwise be claimed as camelCase here and handed out unmapped. */
interface RawToolSource {
  title: string;
  url: string;
  snippet?: string;
}

interface RawMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parent_id?: string;
  created_at: string;
  // Result typing joined from the tool call's `block_stop.final`. Every one is
  // nullable: the server sends null when no block stop matched the row.
  tool_calls?: RawToolCall[] | null;
  sources?: RawToolSource[] | null;
  duration_ms?: number | null;
  is_error?: boolean | null;
  denied_by?: string | null;
  denial_kind?: string | null;
}

/** ONE mapping, shared by the paged and unbounded message reads.
 *
 *  Two copies would drift the moment a field is added to one of them, and the
 *  paged path is the one a new client uses — so the copy that went stale would
 *  be the one nobody was reading while writing the bug. */
function toMessage(m: RawMessage): Message {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role,
    content: m.content,
    parentId: m.parent_id,
    status: "complete" as const,
    createdAt: m.created_at,
    // Server-joined result typing. `?? undefined` rather than `?? null` so an
    // absent field and an explicit null both read as "the server said nothing",
    // which is the one distinction a renderer actually makes here.
    toolCalls: m.tool_calls?.map(toToolCallRequest) ?? undefined,
    sources: m.sources?.map(toToolSource) ?? undefined,
    durationMs: m.duration_ms ?? undefined,
    isError: m.is_error ?? undefined,
    deniedBy: m.denied_by ?? undefined,
    denialKind: m.denial_kind ?? undefined,
  };
}

function toToolSource(s: RawToolSource): ToolSource {
  return { title: s.title, url: s.url, snippet: s.snippet };
}

/** The history row's tool call, in the shape the streaming path already uses. */
function toToolCallRequest(t: RawToolCall): ToolCallRequest {
  return {
    callId: t.call_id,
    toolName: t.tool_name,
    displayName: t.display_name,
    description: t.description,
    arguments: t.arguments ?? {},
    isClientTool: t.is_client_tool ?? false,
    toolCategory: t.tool_category,
    iconUrl: t.icon_url,
  };
}

/**
 * One turn as the conversation's job list describes it.
 *
 * Deliberately WIDER than `restore-plan.ts`'s `RestoreJob`, which is the
 * narrow structural input `planRestore` needs. This is the wire shape, and
 * typing the page with the narrow one would drop `status` and `metrics` on
 * the floor — silently, since a narrower type is assignable.
 */
export interface ConversationJob {
  job_id: string;
  status: string;
  message_id?: string | null;
  metrics?: Record<string, unknown>;
}

/** One page of turns, plus where the next older page starts. */
export interface JobsPage {
  jobs: ConversationJob[];
  hasMore: boolean;
  nextBefore: string | null;
}

/** One page of messages, plus where the next older page starts. */
export interface MessagesPage {
  messages: Message[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}

export class AstralformClient {
  private readonly baseURL: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  /**
   * Auth state is mutable so callers can rotate access tokens or switch
   * agent context without re-instantiating the client. API-key mode is
   * effectively immutable in practice but uses the same shape for uniformity.
   */
  private auth: AuthMode;

  constructor(config: AstralformConfig) {
    if (isApiKeyConfig(config)) {
      if (!config.apiKey || typeof config.apiKey !== "string") {
        throw new Error("apiKey is required and must be a non-empty string");
      }
      if (!config.userId || typeof config.userId !== "string") {
        throw new Error("userId is required in API-key mode");
      }
      this.auth = {
        kind: "api_key",
        apiKey: config.apiKey,
        userId: config.userId,
      };
    } else {
      if (!config.accessToken || typeof config.accessToken !== "string") {
        throw new Error(
          "accessToken is required and must be a non-empty string in user-token mode",
        );
      }
      // agentId is optional — a pre-pick client (right after login) can
      // still hit account-scoped routes like listTeams(). Agent-scoped
      // routes will 4xx until one is set via updateAgentId().
      const agentId =
        typeof config.agentId === "string" && config.agentId.length > 0
          ? config.agentId
          : null;
      this.auth = {
        kind: "user_token",
        accessToken: config.accessToken,
        agentId,
        endUserId:
          typeof config.endUserId === "string" && config.endUserId.length > 0
            ? config.endUserId
            : null,
      };
    }

    this.baseURL = validateBaseURL(config.baseURL ?? DEFAULT_BASE_URL);
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs =
      typeof config.timeoutMs === "number" &&
      Number.isFinite(config.timeoutMs) &&
      config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Replace the current OIDC access token without reconstructing the client.
   * Use after refreshing via the host app's own token manager.
   * Throws if the client was created in API-key mode.
   */
  updateAccessToken(accessToken: string): void {
    if (this.auth.kind !== "user_token") {
      throw new Error("updateAccessToken is only valid in user-token mode");
    }
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("accessToken must be a non-empty string");
    }
    this.auth = { ...this.auth, accessToken };
  }

  /**
   * Swap the active agent for a user-token client. The backend verifies the
   * current developer has access to the new agent; a 403 comes back if not.
   */
  updateAgentId(agentId: string): void {
    if (this.auth.kind !== "user_token") {
      throw new Error("updateAgentId is only valid in user-token mode");
    }
    if (!agentId || typeof agentId !== "string") {
      throw new Error("agentId must be a non-empty string");
    }
    this.auth = { ...this.auth, agentId };
  }

  /**
   * Set (or clear) the end-user override for user-token mode.
   *
   * Pass `null` or an empty string to clear — subsequent requests go
   * back to scoping against the developer's own identity. Throws if
   * called in API-key mode, where end-user context already travels via
   * the constructor's `userId` field.
   */
  updateEndUserId(endUserId: string | null): void {
    if (this.auth.kind !== "user_token") {
      throw new Error("updateEndUserId is only valid in user-token mode");
    }
    const normalized =
      typeof endUserId === "string" && endUserId.length > 0 ? endUserId : null;
    this.auth = { ...this.auth, endUserId: normalized };
  }

  /** Current end-user override in user-token mode, or `null` if unset. */
  get endUserId(): string | null {
    return this.auth.kind === "user_token" ? this.auth.endUserId : null;
  }

  /**
   * Active agent for user-token mode, or `null` if pre-pick (client
   * was constructed without one). For API-key mode the agent is baked
   * into the key, so this getter returns `null` there too — use
   * `authMode` to disambiguate.
   */
  get agentId(): string | null {
    return this.auth.kind === "user_token" ? this.auth.agentId : null;
  }

  /** Which auth mode this client was constructed with. */
  get authMode(): "api_key" | "user_token" {
    return this.auth.kind;
  }

  /**
   * Authorization + identity headers for the current auth mode, without
   * `Content-Type`. Suitable for JSON requests (paired with the JSON header
   * in the `headers` getter) and for multipart uploads where the browser
   * must set its own `Content-Type` boundary.
   */
  private get authHeaders(): Record<string, string> {
    if (this.auth.kind === "api_key") {
      return {
        Authorization: `Bearer ${this.auth.apiKey}`,
        "X-End-User-ID": this.auth.userId,
      };
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.auth.accessToken}`,
    };
    if (this.auth.agentId) {
      headers["X-Agent-ID"] = this.auth.agentId;
    }
    if (this.auth.endUserId) {
      headers["X-End-User-ID"] = this.auth.endUserId;
    }
    return headers;
  }

  private get headers(): Record<string, string> {
    return {
      ...this.authHeaders,
      "Content-Type": "application/json",
    };
  }

  /**
   * Run one REST exchange under a single deadline covering connect, headers,
   * AND the body read. The body read is the part that matters: `json()` used
   * to sit outside every guard, so a response whose headers arrived but whose
   * body stalled hung forever — silently stranding callers that await it
   * (a stalled `getMessages` used to leave `StreamManager.restore()` parked
   * before it ever fetched the events it renders from).
   *
   * The controller is created per request and is deliberately NOT the
   * session's — that one means "the user cancelled this turn" and is null
   * outside a live turn. Aborting frees the socket; the race guarantees a
   * rejection even when an injected `fetch` ignores the signal.
   */
  private async withDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timedOut = () =>
      new ConnectionError(`Request timed out after ${this.timeoutMs}ms`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timedOut());
      }, this.timeoutMs);
    });
    try {
      // Promise.race subscribes to both inputs, so the loser's later
      // rejection (the abort landing after the deadline won) counts as
      // handled and can't surface as an unhandled rejection.
      return await Promise.race([run(controller.signal), deadline]);
    } catch (err) {
      // A signal-honouring fetch rejects with AbortError before the race
      // settles — normalize it to the same timeout error either way.
      if (controller.signal.aborted) throw timedOut();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return this.withDeadline((signal) => this.send(method, path, body, signal));
  }

  /** Fetch + status handling. Always called inside `withDeadline`. */
  private async send(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetchFn(`${this.baseURL}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    }).catch((err) => {
      throw new ConnectionError(
        err instanceof Error ? err.message : "Failed to connect",
      );
    });
    await this.handleError(response);
    return response;
  }

  // DO NOT refactor these back into `request()` + `.json()`. Parsing the body
  // INSIDE the raced callback is the entire fix: `json()` outside the deadline
  // is the original bug (headers arrive, body stalls, caller hangs forever).
  // `request()` survives for `del()`, which never reads the body.

  /**
   * A GET whose response HEADERS the caller needs, not only its body.
   *
   * Paging metadata rides on headers (`X-Has-More`, `X-Next-Before`) because
   * the bodies are bare lists that installed clients already parse as such.
   * Reading them needs the `Response`, which `get<T>` discards.
   *
   * Note the shape: the body is parsed INSIDE the raced callback, exactly as
   * `get`/`post`/`patch` do. See the comment above them — doing the parse
   * outside the deadline is the original hang, and this method is not an
   * exception to it.
   */
  private async getWithHeaders<T>(
    path: string,
  ): Promise<{ data: T; headers: Headers }> {
    return this.withDeadline(async (signal) => {
      const response = await this.send("GET", path, undefined, signal);
      const data = (await response.json()) as T;
      return { data, headers: response.headers };
    });
  }

  async get<T>(path: string): Promise<T> {
    return this.withDeadline(async (signal) => {
      const response = await this.send("GET", path, undefined, signal);
      return (await response.json()) as T;
    });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.withDeadline(async (signal) => {
      const response = await this.send("POST", path, body, signal);
      return (await response.json()) as T;
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.withDeadline(async (signal) => {
      const response = await this.send("PATCH", path, body, signal);
      return (await response.json()) as T;
    });
  }

  private async del(path: string): Promise<void> {
    await this.request("DELETE", path);
  }

  private async handleError(response: Response): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    switch (response.status) {
      case 401:
        throw new AuthenticationError();
      case 429:
        throw createRateLimitErrorFromHttp(response, text);
      default: {
        const safeText = text ? sanitizeErrorText(text) : "";
        // Status carried alongside the message: callers that need to tell one
        // failure from another (a 404 meaning "already gone" from a 500 meaning
        // "we don't know") were left parsing prose otherwise.
        throw new ServerError(
          safeText || `HTTP ${response.status}`,
          response.status,
        );
      }
    }
  }

  // --- REST Methods ---

  async getHealth(): Promise<{
    status: string;
    version: string;
    ollama_connected: boolean;
  }> {
    return this.get("/v1/health");
  }

  // Agent readiness check, scoped to the client's active agent via X-Agent-ID.
  async getAgentStatus(): Promise<AgentStatus> {
    const raw = await this.get<{
      is_ready: boolean;
      llm_configured: boolean;
      llm_provider?: string;
      llm_model?: string;
      message: string;
      ui_components?: {
        enabled?: boolean;
        protocol?: string | null;
        mime_type?: string | null;
      };
      capabilities?: Array<{ key?: string; enabled?: boolean }>;
    }>("/v1/agent/status");
    const ui = raw.ui_components ?? {};
    return {
      isReady: raw.is_ready,
      llmConfigured: raw.llm_configured,
      llmProvider: raw.llm_provider,
      llmModel: raw.llm_model,
      message: raw.message,
      // Defaults to [] rather than undefined so a caller can iterate without a
      // guard, and so a server that predates the field behaves as "reports
      // nothing" instead of throwing. Entries missing a key are dropped: a
      // capability with no name cannot be matched against and would render as
      // an unlabelled row.
      capabilities: (raw.capabilities ?? []).flatMap((c) =>
        typeof c?.key === "string" && c.key.length > 0
          ? [{ key: c.key, enabled: Boolean(c.enabled) }]
          : [],
      ),
      uiComponents: {
        enabled: Boolean(ui.enabled),
        protocol: ui.protocol ?? null,
        mimeType: ui.mime_type ?? null,
      },
    };
  }

  /**
   * A page of conversations, newest-updated first.
   *
   * `options.repository` narrows to one project's tasks (`owner/repo`) — the same
   * paging applies within the filter, so a client showing tasks per project pages
   * each project separately. Tasks that named no repository fall outside every
   * such filter; list them with no filter at all.
   */
  async getConversations(
    limit = 50,
    offset = 0,
    options?: { repository?: string },
  ): Promise<Conversation[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit))));
    const safeOffset = Math.max(0, Math.floor(Number(offset)));
    const filter = options?.repository
      ? `&repository=${encodeURIComponent(options.repository)}`
      : "";
    const raw = await this.get<
      {
        id: string;
        title: string;
        message_count: number;
        created_at: string;
        updated_at: string;
        repository?: string | null;
      }[]
    >(`/v1/conversations?limit=${safeLimit}&offset=${safeOffset}${filter}`);
    return raw.map((c) => camelizeKeys<Conversation>(c as unknown as Record<string, unknown>));
  }

  /**
   * One page of a conversation's turns, newest-first window returned oldest-first.
   *
   * `hasMore` asks "are there OLDER turns beyond this page" — the only
   * direction a restore pages in, since it starts at the tail.
   *
   * **Degrades on an old backend.** A server without the cursor ignores the
   * unknown `limit` query param and returns the whole list, and its response
   * carries neither header — which reads here as one page with nothing older,
   * i.e. exactly today's behaviour. That is why absent headers must mean
   * `hasMore: false` rather than an error: the fallback has to be "everything
   * arrived", not "paging is broken".
   */
  async getConversationJobsPage(
    conversationId: string,
    options?: { limit?: number; before?: string },
  ): Promise<JobsPage> {
    const params = new URLSearchParams();
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.before) params.set("before", options.before);
    const query = params.toString();
    const { data, headers } = await this.getWithHeaders<ConversationJob[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/jobs${
        query ? `?${query}` : ""
      }`,
    );
    return {
      jobs: data,
      hasMore: headers.get("X-Has-More") === "true",
      nextBefore: headers.get("X-Next-Before"),
    };
  }

  /**
   * One page of a conversation's messages, oldest-first within the page.
   *
   * Deliberately NOT folded into `getMessages`: that method is public surface
   * whose `Message[]` return type callers depend on, and the server keeps its
   * unbounded branch for exactly the same reason.
   *
   * Degrades like `getConversationJobsPage` — an old server ignores `limit`
   * and returns the whole branch with no headers, which reads as a single
   * complete page.
   */
  async getMessagesPage(
    conversationId: string,
    options: { limit: number; beforeSeq?: number },
  ): Promise<MessagesPage> {
    const params = new URLSearchParams({ limit: String(options.limit) });
    if (options.beforeSeq != null) {
      params.set("before_seq", String(options.beforeSeq));
    }
    const { data, headers } = await this.getWithHeaders<RawMessage[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
    );
    const next = headers.get("X-Next-Before-Seq");
    return {
      messages: data.map(toMessage),
      hasMore: headers.get("X-Has-More") === "true",
      nextBeforeSeq: next == null ? null : Number(next),
    };
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const raw = await this.get<RawMessage[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    return raw.map(toMessage);
  }

  /**
   * Replace the title the server generated from the conversation's first turn.
   *
   * The server does NOT bump `updated_at` for a rename — conversations list
   * newest-updated first, and relabelling one is not activity — so the
   * timestamp coming back is the original. Callers should merge the response
   * rather than stamp their own, or they reintroduce the reordering the
   * server deliberately avoids.
   */
  async renameConversation(id: string, title: string): Promise<Conversation> {
    const c = await this.patch<{
      id: string;
      title: string;
      message_count: number;
      created_at: string;
      updated_at: string;
    }>(`/v1/conversations/${encodeURIComponent(id)}`, { title });
    return camelizeKeys<Conversation>(c as unknown as Record<string, unknown>);
  }

  async deleteConversation(id: string): Promise<void> {
    await this.del(`/v1/conversations/${encodeURIComponent(id)}`);
  }

  /**
   * List the AI personas (sub-agents) available INSIDE the client's active
   * agent workspace — orchestrator + specialists, addressed per message via
   * `ChatStreamRequest.agent_name`. Not to be confused with `listAgents()`,
   * which enumerates the team-level agents a signed-in user can open.
   */
  async getAgents(): Promise<AgentInfo[]> {
    const raw = await this.get<
      {
        name: string;
        display_name: string;
        description: string;
        is_orchestrator: boolean;
        is_enabled: boolean;
        avatar_url?: string;
        code_projects_enabled?: boolean;
      }[]
    >("/v1/agents");
    return raw.map((a) => camelizeKeys<AgentInfo>(a as unknown as Record<string, unknown>));
  }

  /**
   * List the models the caller may pick this turn — expanded from the curated
   * catalog of the providers the team has connected (client-side model
   * selection). Backs the composer's model picker. Scoped to the active agent
   * via X-Agent-ID, same as {@link getAgentStatus}.
   */
  async getModels(): Promise<ModelOption[]> {
    const raw = await this.get<Record<string, unknown>[]>("/v1/models");
    // camelizeKeys, not a hand-written map: the previous version listed the
    // fields it knew and silently dropped the rest, so `effort_levels` was
    // emitted by the server for months and never reached a caller. Structural
    // mapping means the next field the API adds arrives on its own.
    //
    // Shallow is correct here rather than a limitation. `thinkingControl`'s
    // nested keys (`ladder`, `id`, `label`, `default`) are all single words, so
    // there is nothing to convert inside it — and recursing would rewrite keys
    // inside arbitrary JSON payloads elsewhere in the SDK, which is a worse
    // failure than the one it would prevent. `client.test.ts` pins the key set.
    //
    // Fields whose absence carries no signal — iconUrl/lastUsedAt/useCount and
    // contextWindow — normalize to null, so "no data" is one value rather than
    // undefined-vs-null ambiguity for consumers. thinkingControl deliberately
    // does NOT: there, absence IS the signal, meaning "no control to render".
    // That split is the rule to apply to the next optional field added here.
    return raw.map((m) => {
      const option = camelizeKeys<ModelOption>(m);
      return {
        ...option,
        iconUrl: option.iconUrl ?? null,
        lastUsedAt: option.lastUsedAt ?? null,
        useCount: option.useCount ?? null,
        contextWindow: option.contextWindow ?? null,
      };
    });
  }

  async getSkills(): Promise<SkillInfo[]> {
    const raw = await this.get<
      {
        name: string;
        display_name: string;
        description: string;
        is_enabled: boolean;
      }[]
    >("/v1/skills");
    return raw.map((s) => camelizeKeys<SkillInfo>(s as unknown as Record<string, unknown>));
  }

  /**
   * List the slash commands the active agent offers — the system commands
   * followed by its enabled skills. Backs the composer's "/" menu.
   *
   * @param surface Who will execute them. Omit for the server's default,
   *   `"web"`: what `POST /v1/jobs` runs itself. `"telegram"` returns the
   *   bot's commands under Telegram-valid names; `"all"` returns every
   *   command, including those the other surfaces filter out — `surfaces` is
   *   set on every row either way, and is what tells them apart here.
   *
   * The default surface is not sent as a query parameter. The server already
   * defaults to `web`, so omitting it keeps the request byte-identical to
   * what clients that call the raw path send today — same reasoning as
   * {@link getConversationEvents}'s `toolOutputs`.
   */
  async listSkillCommands(surface?: SlashCommandSurface): Promise<SlashCommand[]> {
    const query = surface && surface !== "web" ? `?surface=${surface}` : "";
    const raw = await this.get<Record<string, unknown>[]>(
      `/v1/skills/commands${query}`,
    );
    // `args_hint` and `surfaces` carry server-side defaults, so an older
    // backend omits them from the row entirely. A menu concatenates argsHint
    // into a label and iterates surfaces; neither may reach a consumer as
    // undefined, so absence normalizes to the empty value the server means.
    return raw.map((c) => {
      const command = camelizeKeys<SlashCommand>(c);
      return {
        ...command,
        displayName: command.displayName ?? "",
        description: command.description ?? "",
        argsHint: command.argsHint ?? "",
        surfaces: command.surfaces ?? [],
      };
    });
  }

  async getConversationEvents(
    conversationId: string,
    jobId?: string,
    options?: { toolOutputs?: ToolOutputMode },
  ): Promise<ConversationEvent[]> {
    const params = new URLSearchParams();
    if (jobId) params.set("job_id", jobId);
    // Only ever SET for "stub". Omitting it entirely when inline keeps the
    // request byte-identical to what every installed client already sends,
    // which is what makes this opt-in rather than a wire change.
    if (options?.toolOutputs === "stub") params.set("tool_outputs", "stub");
    const query = params.toString();
    return this.get(
      `/v1/conversations/${encodeURIComponent(conversationId)}/events${
        query ? `?${query}` : ""
      }`,
    );
  }

  /**
   * The full output behind a {@link ToolOutputStub}.
   *
   * The safe form: the stub carries its own `job_id`, so the scoping that a
   * version-switched read depends on cannot be dropped. See the id overload
   * below for what that scoping is and why omitting it 404s.
   */
  async getToolOutput(
    conversationId: string,
    stub: ToolOutputStub,
  ): Promise<unknown>;
  /**
   * By ids. **Pass `jobId`** — this is the form that can get it wrong.
   *
   * `/events?job_id=X` deliberately returns jobs that regeneration has
   * replaced, since reading a superseded version is the whole purpose of that
   * parameter, while this route excludes them unless scoped to a job. Omit it
   * and the fetch 404s on exactly the pills a version-switched read is
   * displaying. Restore fetches events per job, so that is the normal path.
   *
   * Prefer the overload above, which takes the stub and cannot be got wrong.
   */
  async getToolOutput(
    conversationId: string,
    callId: string,
    jobId?: string,
  ): Promise<unknown>;
  async getToolOutput(
    conversationId: string,
    callIdOrStub: string | ToolOutputStub,
    jobId?: string,
  ): Promise<unknown> {
    // Prefer handing the stub straight in. Every paragraph above says "pass
    // `job_id`", which is a sign an optional parameter is the wrong shape for
    // it: dropping it type-checks, and the failure is invisible until someone
    // regenerates a turn. The stub already carries the id, so this overload
    // makes forgetting it impossible rather than merely documented.
    const callId =
      typeof callIdOrStub === "string" ? callIdOrStub : callIdOrStub.call_id;
    const job =
      typeof callIdOrStub === "string" ? jobId : callIdOrStub.job_id;
    const query = job ? `?job_id=${encodeURIComponent(job)}` : "";
    const res = await this.get<{ call_id: string; output: unknown }>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/tool-output/${encodeURIComponent(callId)}${query}`,
    );
    return res.output;
  }

  async submitToolResult(request: ToolResultRequest): Promise<void> {
    await this.post("/v1/tool-result", request);
  }

  async submitToolApproval(request: ToolApprovalRequest): Promise<void> {
    await this.post("/v1/tool-approval", request);
  }

  // --- End-user tool-permission self-service ---

  /**
   * List the current end user's own remembered tool-permission grants.
   * Only `conversation`/`always` grants exist (`once` is never persisted).
   * Paginated via `limit` (default 100, max 200) / `offset`; `total` lets you
   * page through all of them.
   */
  async getMyToolPermissions(options?: {
    limit?: number;
    offset?: number;
  }): Promise<MyToolGrantsPage> {
    const params = new URLSearchParams();
    if (options?.limit != null) {
      const safeLimit = Math.max(
        1,
        Math.min(200, Math.floor(Number(options.limit))),
      );
      params.set("limit", String(safeLimit));
    }
    if (options?.offset != null) {
      const safeOffset = Math.max(0, Math.floor(Number(options.offset)));
      params.set("offset", String(safeOffset));
    }
    const qs = params.toString();
    const raw = await this.get<{
      grants: {
        id: string;
        tool_name: string;
        decision: "allow" | "deny";
        scope: "conversation" | "always";
        conversation_id: string | null;
        created_at: string;
      }[];
      total: number;
      limit: number;
      offset: number;
    }>(`/v1/me/tool-permissions${qs ? `?${qs}` : ""}`);
    return {
      grants: raw.grants.map((g) => ({
        id: g.id,
        toolName: g.tool_name,
        decision: g.decision,
        scope: g.scope,
        conversationId: g.conversation_id,
        createdAt: g.created_at,
      })),
      total: raw.total,
      limit: raw.limit,
      offset: raw.offset,
    };
  }

  /**
   * Revoke one of the current end user's remembered grants by id. The agent
   * will ask again the next time that tool is used.
   */
  async revokeToolPermission(id: string): Promise<void> {
    await this.del(`/v1/me/tool-permissions/${encodeURIComponent(id)}`);
  }

  // --- Conversation Assets ---

  private mapAsset(raw: Record<string, unknown>): ConversationAsset {
    return {
      id: raw.id as string,
      kind: raw.kind as "upload" | "output",
      originalName: raw.original_name as string,
      mediaType: raw.media_type as string,
      sizeBytes: raw.size_bytes as number,
      workspacePath: raw.workspace_path as string | undefined,
      sourceMessageId: raw.source_message_id as string | undefined,
      agentName: raw.agent_name as string | undefined,
      // The API serializes an unsigned asset as `url: null`; normalize to
      // undefined so it matches the `url?: string` type and consumers that
      // check `!== undefined` never receive a null.
      url: (raw.url as string | null) ?? undefined,
      // This mapping is an ALLOWLIST — a field the API returns and this
      // function does not name is dropped silently, and no type error says so.
      // `content_url` shipped that way and was invisible to every consumer.
      contentUrl: (raw.content_url as string | null) ?? undefined,
      posterUrl: (raw.poster_url as string | null) ?? undefined,
      createdAt: raw.created_at as string,
    };
  }

  async uploadFile(
    conversationId: string,
    file: Blob,
    filename?: string,
  ): Promise<ConversationAsset> {
    const formData = new FormData();
    formData.append("file", file, filename);

    const response = await this.fetchFn(
      `${this.baseURL}/v1/conversations/${encodeURIComponent(conversationId)}/uploads`,
      {
        method: "POST",
        headers: this.authHeaders,
        body: formData,
      },
    ).catch((err) => {
      throw new ConnectionError(
        err instanceof Error ? err.message : "Failed to connect",
      );
    });
    await this.handleError(response);
    const raw = await response.json();
    return this.mapAsset(raw as Record<string, unknown>);
  }

  // --- Voice input ---

  /** The agent's voice-input defaults (`GET /v1/voice/config`). */
  async getVoiceConfig(): Promise<VoiceConfig> {
    const raw = await this.get<Record<string, unknown>>("/v1/voice/config");
    return {
      enabled: Boolean(raw.enabled),
      modes: (raw.modes as string[] | undefined) ?? [...VOICE_POLISH_MODES],
      // A mode this SDK does not know must not reach a `switch` typed as
      // `VoicePolishMode`; `structured` is the server's own default.
      defaultMode: isVoicePolishMode(raw.default_mode) ? raw.default_mode : "structured",
      silenceAutoStopSeconds:
        (raw.silence_auto_stop_seconds as number | undefined) ?? 2,
      autoSend: (raw.auto_send as boolean | undefined) ?? true,
      maxRecordingSeconds: (raw.max_recording_seconds as number | undefined) ?? 300,
      supportsStreaming: Boolean(raw.supports_streaming),
      hotwords: (raw.hotwords as string[] | undefined) ?? [],
    };
  }

  /**
   * Transcribe one recording with the agent's configured speech-to-text
   * provider (`POST /v1/voice/transcriptions`). 16 kHz mono 16-bit WAV is the
   * reference format; anything the provider accepts works.
   *
   * Deliberately outside `withDeadline`: a recording can run to
   * `VoiceConfig.maxRecordingSeconds`, so the 30 s default would cut real
   * uploads off. Pass `options.signal` to give up on a stalled one; the
   * promise then rejects with the abort reason — the runtime's `AbortError`,
   * or whatever was passed to `abort(reason)`.
   */
  async transcribeVoice(
    audio: Blob,
    options: VoiceTranscribeOptions = {},
  ): Promise<VoiceTranscript> {
    const formData = new FormData();
    formData.append("file", audio, options.filename ?? "recording.wav");
    if (options.hotwords?.length) {
      // The form field is a comma-separated string — the server splits it on
      // commas (and newlines), so this is the wire format, not a choice made
      // here. A word containing a comma arrives as two.
      formData.append("hotwords", options.hotwords.join(", "));
    }
    if (options.language) {
      formData.append("language", options.language);
    }
    const response = await this.fetchFn(`${this.baseURL}/v1/voice/transcriptions`, {
      method: "POST",
      headers: this.authHeaders,
      body: formData,
      signal: options.signal,
    }).catch((err) => {
      // Any abort is the caller's, not a failure — including `abort(reason)`,
      // which rejects with the caller's own error rather than an AbortError.
      if (options.signal?.aborted) {
        throw err;
      }
      throw new ConnectionError(
        err instanceof Error ? err.message : "Failed to connect",
      );
    });
    await this.handleError(response);
    const raw = (await response.json()) as Record<string, unknown>;
    return {
      text: (raw.text as string | undefined) ?? "",
      language: (raw.language as string | null | undefined) ?? null,
      durationMs: (raw.duration_ms as number | null | undefined) ?? null,
      asrMs: (raw.asr_ms as number | undefined) ?? 0,
    };
  }

  /**
   * Stream the LLM rewrite of a transcript (`POST /v1/voice/polish`) as typed
   * frames.
   *
   * Failures the server reports mid-stream arrive as an `error` frame, but
   * the iteration itself can reject: aborting `signal` closes the connection
   * (which cancels the model call upstream) and rejects with
   * `StreamAbortedError`; a non-2xx open rejects with `AuthenticationError`,
   * `RateLimitError` or `ServerError`; a network failure with
   * `ConnectionError`. Wrap the `for await` accordingly.
   */
  async *streamVoicePolish(
    request: VoicePolishRequest,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<VoicePolishEvent> {
    const frames = streamJobSSE({
      url: `${this.baseURL}/v1/voice/polish`,
      headers: { ...this.headers, Accept: "text/event-stream" },
      method: "POST",
      body: JSON.stringify({
        text: request.text,
        mode: request.mode,
        hotwords: request.hotwords ?? [],
      }),
      signal: options.signal,
      fetchFn: this.fetchFn,
    });
    for await (const frame of frames) {
      const event = parseVoicePolishFrame(frame);
      if (event) yield event;
    }
  }

  async listUploads(conversationId: string): Promise<ConversationAsset[]> {
    const raw = await this.get<Record<string, unknown>[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/uploads`,
    );
    return raw.map((r) => this.mapAsset(r));
  }

  async listOutputs(conversationId: string): Promise<ConversationAsset[]> {
    const raw = await this.get<Record<string, unknown>[]>(
      `/v1/conversations/${encodeURIComponent(conversationId)}/outputs`,
    );
    return raw.map((r) => this.mapAsset(r));
  }

  // --- Account-scoped discovery (user-token mode) ---
  //
  // Lets a signed-in user pick which team/agent they want to act on.
  // Backend gates these on OIDC user context (no X-Agent-ID required) —
  // sending them in API-key mode yields 401.

  async listTeams(): Promise<TeamSummary[]> {
    const raw = await this.get<
      Array<{
        id: string;
        name: string;
        slug: string;
        is_default: boolean;
        role: string;
      }>
    >("/v1/teams");
    return raw.map((t) => camelizeKeys<TeamSummary>(t as unknown as Record<string, unknown>));
  }

  /**
   * List the team-level agents (formerly "projects") the signed-in user can
   * open — the pickable workspaces under a team. Not to be confused with
   * `getAgents()`, which lists the AI personas inside the active agent.
   */
  async listAgents(teamId: string): Promise<TeamAgentSummary[]> {
    const raw = await this.get<
      Array<{
        id: string;
        name: string;
        display_name?: string | null;
        team_id: string;
        created_at: string;
        updated_at: string;
        avatar_url?: string | null;
      }>
    >(`/v1/teams/${encodeURIComponent(teamId)}/agents`);
    return raw.map((a) => camelizeKeys<TeamAgentSummary>(a as unknown as Record<string, unknown>));
  }

  // --- Projects: the repositories this app user works with ---

  /**
   * The projects (GitHub repositories) this app user works with, and what they
   * may add.
   *
   * A project list is per app user: the developer connects the workspace's GitHub
   * account, and each user curates their own list from what that connection
   * covers. There is no agent-level gate — an agent with no GitHub lists nothing,
   * reports `not_installed` from `available()`, and refuses `add()`. Read
   * {@link AgentInfo.codeProjectsEnabled} to decide whether to show the surface.
   */
  readonly code = {
    projects: {
      /** This user's projects on the active agent, oldest first. */
      list: async (): Promise<CodeProject[]> => {
        const raw = await this.get<{ repo_full_name: string; added_at: string }[]>(
          "/v1/code/projects",
        );
        return raw.map((p) => camelizeKeys<CodeProject>(p as unknown as Record<string, unknown>));
      },

      /**
       * What the workspace's GitHub installations cover, minus what this user
       * has already added. Read `state` before the list: an empty `repositories`
       * means something different in each of its three values.
       */
      available: async (): Promise<AvailableRepositories> => {
        const raw = await this.get<{
          state: "ok" | "unavailable" | "not_installed";
          repositories: { full_name: string; private: boolean }[];
          total_count: number;
          partial: boolean;
        }>("/v1/code/projects/available");
        return {
          state: raw.state,
          repositories: (raw.repositories ?? []).map((r) => ({
            fullName: r.full_name,
            private: r.private,
          })),
          // Defaulted like its neighbours: the `unavailable` branch has nothing
          // to count, and an absent field behind a `number` type prints
          // "undefined" in a picker rather than a number.
          totalCount: raw.total_count ?? 0,
          partial: raw.partial ?? false,
        };
      },

      /**
       * Add a repository. The server checks it against the workspace's own
       * installations and answers a repository it cannot reach the same way it
       * answers one owned by someone else — deliberately, so this call cannot be
       * used to discover which organisations use Astralform.
       */
      add: async (repoFullName: string): Promise<CodeProject> => {
        const raw = await this.post<{ repo_full_name: string; added_at: string }>(
          "/v1/code/projects",
          { repo_full_name: repoFullName },
        );
        return camelizeKeys<CodeProject>(raw as unknown as Record<string, unknown>);
      },

      /**
       * Remove a project. Tasks already bound to that repository keep their
       * binding — they simply stop grouping under it.
       */
      remove: async (owner: string, repo: string): Promise<void> => {
        await this.del(
          `/v1/code/projects/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        );
      },
    },
  };

  // --- Jobs API ---

  async createJob(request: ChatStreamRequest): Promise<JobCreateResponse> {
    return this.post<JobCreateResponse>("/v1/jobs", request);
  }

  async *streamJobEvents(
    jobId: string,
    afterSeq = -1,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const url = `${this.baseURL}/v1/jobs/${encodeURIComponent(jobId)}/events?after=${afterSeq}`;
    yield* streamJobSSE({
      url,
      headers: this.headers,
      signal,
      fetchFn: this.fetchFn,
    });
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.post(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  async getJob(jobId: string): Promise<JobStatus> {
    const raw = await this.get<{
      job_id: string;
      status: string;
      created_at?: string | null;
      started_at?: string | null;
      completed_at?: string | null;
      error_message?: string | null;
      input_tokens?: number;
      output_tokens?: number;
    }>(`/v1/jobs/${encodeURIComponent(jobId)}`);
    return {
      jobId: raw.job_id,
      status: raw.status,
      createdAt: raw.created_at ?? null,
      startedAt: raw.started_at ?? null,
      completedAt: raw.completed_at ?? null,
      errorMessage: raw.error_message ?? null,
      inputTokens: raw.input_tokens ?? 0,
      outputTokens: raw.output_tokens ?? 0,
    };
  }

  async submitFeedback(
    jobId: string,
    request: FeedbackRequest,
  ): Promise<FeedbackResponse> {
    const body: { rating: 1 | -1; comment?: string } = {
      rating: request.rating,
    };
    if (request.comment != null) body.comment = request.comment;
    const raw = await this.post<{
      id: string;
      job_id: string;
      rating: number;
      comment: string | null;
      created_at: string;
    }>(`/v1/jobs/${encodeURIComponent(jobId)}/feedback`, body);
    return camelizeKeys<FeedbackResponse>(raw as unknown as Record<string, unknown>);
  }

  async getActiveJob(conversationId: string): Promise<ActiveJob> {
    const raw = await this.get<{
      job_id: string | null;
      status: string;
    }>(`/v1/conversations/${encodeURIComponent(conversationId)}/active-job`);
    return {
      jobId: raw.job_id ?? null,
      status: raw.status,
    };
  }

  async listJobs(conversationId: string): Promise<JobSummary[]> {
    const raw = await this.get<
      {
        job_id: string;
        status: string;
        replaces_job_id?: string | null;
        response_content?: Record<string, unknown> | null;
        metrics?: Record<string, unknown> | null;
        created_at?: string | null;
      }[]
    >(`/v1/conversations/${encodeURIComponent(conversationId)}/jobs`);
    return raw.map((j) => ({
      jobId: j.job_id,
      status: j.status,
      replacesJobId: j.replaces_job_id ?? null,
      responseContent: j.response_content ?? null,
      metrics: j.metrics ?? null,
      createdAt: j.created_at ?? null,
    }));
  }
}

/**
 * Decode one SSE frame of `POST /v1/voice/polish`; null for frames the
 * client does not act on (pings, unknown events).
 */
export function parseVoicePolishFrame(frame: {
  event: string;
  data: string;
}): VoicePolishEvent | null {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    // `null`, `true`, `42` and `[]` all parse; only a plain object carries
    // the fields read below (an array would synthesize an `error` event), and
    // a throw here would end the whole polish generator.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (frame.event) {
    case "delta":
      return typeof payload.text === "string"
        ? { type: "delta", text: payload.text }
        : null;
    case "done":
      return typeof payload.text === "string"
        ? {
            type: "done",
            text: payload.text,
            polishMs: (payload.polish_ms as number | undefined) ?? 0,
          }
        : null;
    case "error":
      return {
        type: "error",
        reason: (payload.reason as string | undefined) ?? "unknown",
        partial: (payload.partial as string | undefined) ?? "",
        ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
      };
    default:
      return null;
  }
}
