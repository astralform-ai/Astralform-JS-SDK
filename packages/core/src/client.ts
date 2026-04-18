import { AuthenticationError, ConnectionError, ServerError } from "./errors.js";
import { createRateLimitErrorFromHttp } from "./rate-limit.js";
import { streamJobSSE } from "./streaming.js";
import { sanitizeErrorText } from "./utils.js";
import type {
  ActiveJob,
  AgentInfo,
  AstralformApiKeyConfig,
  AstralformConfig,
  ChatStreamEvent,
  ChatStreamRequest,
  ConversationAsset,
  ConversationEvent,
  Conversation,
  FeedbackRequest,
  FeedbackResponse,
  JobCreateResponse,
  JobStatus,
  JobSummary,
  Message,
  ProjectStatus,
  ProjectSummary,
  SkillInfo,
  TeamSummary,
  ToolApprovalRequest,
  ToolResultRequest,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.astralform.ai";

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
      /** Null until the user picks a project; account-scoped calls still work. */
      projectId: string | null;
      /** Optional end-user override. When present, sent as X-End-User-ID. */
      endUserId: string | null;
    };

export class AstralformClient {
  private readonly baseURL: string;
  private readonly fetchFn: typeof globalThis.fetch;
  /**
   * Auth state is mutable so callers can rotate access tokens or switch
   * project context without re-instantiating the client. API-key mode is
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
      // projectId is optional — a pre-pick client (right after login) can
      // still hit account-scoped routes like listTeams(). Project-scoped
      // routes will 4xx until one is set via updateProjectId().
      const projectId =
        typeof config.projectId === "string" && config.projectId.length > 0
          ? config.projectId
          : null;
      this.auth = {
        kind: "user_token",
        accessToken: config.accessToken,
        projectId,
        endUserId:
          typeof config.endUserId === "string" && config.endUserId.length > 0
            ? config.endUserId
            : null,
      };
    }

    this.baseURL = validateBaseURL(config.baseURL ?? DEFAULT_BASE_URL);
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Replace the current OIDC access token without reconstructing the client.
   * Use after refreshing via the host's token manager (e.g., Supabase JS SDK).
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
   * Swap the active project for a user-token client. The backend verifies the
   * current developer has access to the new project; a 403 comes back if not.
   */
  updateProjectId(projectId: string): void {
    if (this.auth.kind !== "user_token") {
      throw new Error("updateProjectId is only valid in user-token mode");
    }
    if (!projectId || typeof projectId !== "string") {
      throw new Error("projectId must be a non-empty string");
    }
    this.auth = { ...this.auth, projectId };
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
   * Active project for user-token mode, or `null` if pre-pick (client
   * was constructed without one). For API-key mode the project is baked
   * into the key, so this getter returns `null` there too — use
   * `authMode` to disambiguate.
   */
  get projectId(): string | null {
    return this.auth.kind === "user_token" ? this.auth.projectId : null;
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
    if (this.auth.projectId) {
      headers["X-Project-ID"] = this.auth.projectId;
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

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const response = await this.fetchFn(`${this.baseURL}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).catch((err) => {
      throw new ConnectionError(
        err instanceof Error ? err.message : "Failed to connect",
      );
    });
    await this.handleError(response);
    return response;
  }

  async get<T>(path: string): Promise<T> {
    const response = await this.request("GET", path);
    return response.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request("POST", path, body);
    return response.json() as Promise<T>;
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
        throw new ServerError(safeText || `HTTP ${response.status}`);
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

  async getProjectStatus(): Promise<ProjectStatus> {
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
    }>("/v1/project/status");
    const ui = raw.ui_components ?? {};
    return {
      isReady: raw.is_ready,
      llmConfigured: raw.llm_configured,
      llmProvider: raw.llm_provider,
      llmModel: raw.llm_model,
      message: raw.message,
      uiComponents: {
        enabled: Boolean(ui.enabled),
        protocol: ui.protocol ?? null,
        mimeType: ui.mime_type ?? null,
      },
    };
  }

  async getConversations(limit = 50, offset = 0): Promise<Conversation[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit))));
    const safeOffset = Math.max(0, Math.floor(Number(offset)));
    const raw = await this.get<
      {
        id: string;
        title: string;
        message_count: number;
        created_at: string;
        updated_at: string;
      }[]
    >(`/v1/conversations?limit=${safeLimit}&offset=${safeOffset}`);
    return raw.map((c) => ({
      id: c.id,
      title: c.title,
      messageCount: c.message_count,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const raw = await this.get<
      {
        id: string;
        conversation_id: string;
        role: "user" | "assistant" | "system";
        content: string;
        parent_id?: string;
        created_at: string;
      }[]
    >(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`);
    return raw.map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      role: m.role,
      content: m.content,
      parentId: m.parent_id,
      status: "complete" as const,
      createdAt: m.created_at,
    }));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.del(`/v1/conversations/${encodeURIComponent(id)}`);
  }

  async getAgents(): Promise<AgentInfo[]> {
    const raw = await this.get<
      {
        name: string;
        display_name: string;
        description: string;
        is_orchestrator: boolean;
        is_enabled: boolean;
        avatar_url?: string;
      }[]
    >("/v1/agents");
    return raw.map((a) => ({
      name: a.name,
      displayName: a.display_name,
      description: a.description,
      isOrchestrator: a.is_orchestrator,
      isEnabled: a.is_enabled,
      avatarUrl: a.avatar_url,
    }));
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
    return raw.map((s) => ({
      name: s.name,
      displayName: s.display_name,
      description: s.description,
      isEnabled: s.is_enabled,
    }));
  }

  async getConversationEvents(
    conversationId: string,
    jobId?: string,
  ): Promise<ConversationEvent[]> {
    let url = `/v1/conversations/${encodeURIComponent(conversationId)}/events`;
    if (jobId) url += `?job_id=${encodeURIComponent(jobId)}`;
    return this.get(url);
  }

  async submitToolResult(request: ToolResultRequest): Promise<void> {
    await this.post("/v1/tool-result", request);
  }

  async submitToolApproval(request: ToolApprovalRequest): Promise<void> {
    await this.post("/v1/tool-approval", request);
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
  // Lets a signed-in user pick which team/project they want to act on.
  // Backend gates these on OIDC user context (no X-Project-ID required) —
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
    return raw.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      isDefault: t.is_default,
      role: t.role,
    }));
  }

  async listProjects(teamId: string): Promise<ProjectSummary[]> {
    const raw = await this.get<
      Array<{
        id: string;
        name: string;
        team_id: string;
        created_at: string;
        updated_at: string;
      }>
    >(`/v1/teams/${encodeURIComponent(teamId)}/projects`);
    return raw.map((p) => ({
      id: p.id,
      name: p.name,
      teamId: p.team_id,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }));
  }

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
    return {
      id: raw.id,
      jobId: raw.job_id,
      rating: raw.rating,
      comment: raw.comment,
      createdAt: raw.created_at,
    };
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
