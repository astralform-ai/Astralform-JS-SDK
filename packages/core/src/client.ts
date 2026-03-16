import {
  AuthenticationError,
  ConnectionError,
  RateLimitError,
  ServerError,
} from "./errors.js";
import { streamJobSSE } from "./streaming.js";
import type {
  AgentInfo,
  AstralformConfig,
  ChatStreamEvent,
  ChatStreamRequest,
  ConversationAsset,
  Conversation,
  JobCreateResponse,
  Message,
  ProjectStatus,
  SkillInfo,
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

export class AstralformClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly userId: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: AstralformConfig) {
    if (!config.apiKey || typeof config.apiKey !== "string") {
      throw new Error("apiKey is required and must be a non-empty string");
    }
    this.apiKey = config.apiKey;
    this.baseURL = validateBaseURL(config.baseURL ?? DEFAULT_BASE_URL);
    this.userId = config.userId;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-End-User-ID": this.userId,
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

  private async get<T>(path: string): Promise<T> {
    const response = await this.request("GET", path);
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
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
        throw new RateLimitError();
      default: {
        // Sanitize server error text to avoid leaking sensitive details
        const safeText = text
          ? text.slice(0, 500).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
          : "";
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
    }>("/v1/project/status");
    return {
      isReady: raw.is_ready,
      llmConfigured: raw.llm_configured,
      llmProvider: raw.llm_provider,
      llmModel: raw.llm_model,
      message: raw.message,
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

  async submitToolResult(request: ToolResultRequest): Promise<void> {
    await this.post("/v1/tool-result", request);
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
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-End-User-ID": this.userId,
        },
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
}
