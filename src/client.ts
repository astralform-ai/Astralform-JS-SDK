import {
  AuthenticationError,
  ConnectionError,
  RateLimitError,
  ServerError,
} from "./errors.js";
import { streamSSE } from "./streaming.js";
import type {
  AgentInfo,
  AstralformConfig,
  ChatStreamEvent,
  ChatStreamRequest,
  Conversation,
  Message,
  PlatformTool,
  ProjectStatus,
  ServerMCPTool,
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

  async getTools(): Promise<PlatformTool[]> {
    const raw = await this.get<
      {
        name: string;
        display_name: string;
        description: string;
        icon?: string;
      }[]
    >("/v1/tools");
    return raw.map((t) => ({
      name: t.name,
      displayName: t.display_name,
      description: t.description,
      icon: t.icon,
    }));
  }

  async getMcpTools(): Promise<ServerMCPTool[]> {
    const raw = await this.get<
      {
        name: string;
        description: string;
        server_name: string;
      }[]
    >("/v1/mcp-tools");
    return raw.map((t) => ({
      name: t.name,
      description: t.description,
      serverName: t.server_name,
    }));
  }

  async getAgents(): Promise<AgentInfo[]> {
    const raw = await this.get<
      {
        name: string;
        display_name: string;
        description: string;
        is_default: boolean;
        is_enabled: boolean;
      }[]
    >("/v1/agents");
    return raw.map((a) => ({
      name: a.name,
      displayName: a.display_name,
      description: a.description,
      isDefault: a.is_default,
      isEnabled: a.is_enabled,
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

  // --- Streaming ---

  async *chatStream(
    request: ChatStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    yield* streamSSE({
      url: `${this.baseURL}/v1/chat/stream`,
      body: request,
      headers: this.headers,
      signal,
      fetchFn: this.fetchFn,
    });
  }
}
