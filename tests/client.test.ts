import { describe, it, expect } from "vitest";
import { AstralformClient } from "../src/client.js";
import { AuthenticationError } from "../src/errors.js";
import { createMockFetch } from "./helpers.js";

describe("AstralformClient", () => {
  const config = {
    apiKey: "test-key",
    baseURL: "http://localhost:8000",
    userId: "user-1",
  };

  it("sets correct headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      capturedHeaders = headers;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await client.getHealth();

    expect(capturedHeaders["Authorization"]).toBe("Bearer test-key");
    expect(capturedHeaders["X-End-User-ID"]).toBe("user-1");
  });

  it("getProjectStatus maps snake_case to camelCase", async () => {
    const mockFetch = createMockFetch({
      "/v1/project/status": {
        status: 200,
        body: {
          is_ready: true,
          llm_configured: true,
          llm_provider: "openai",
          llm_model: "gpt-4o",
          message: "Ready",
        },
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const status = await client.getProjectStatus();

    expect(status.isReady).toBe(true);
    expect(status.llmConfigured).toBe(true);
    expect(status.llmProvider).toBe("openai");
    expect(status.llmModel).toBe("gpt-4o");
  });

  it("getConversations returns mapped conversations", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations": {
        status: 200,
        body: [
          {
            id: "c1",
            title: "Test",
            message_count: 5,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const convos = await client.getConversations();

    expect(convos).toHaveLength(1);
    expect(convos[0]!.messageCount).toBe(5);
    expect(convos[0]!.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("getTools maps display_name to displayName", async () => {
    const mockFetch = createMockFetch({
      "/v1/tools": {
        status: 200,
        body: [
          {
            name: "search",
            display_name: "Web Search",
            description: "Search the web",
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const tools = await client.getTools();

    expect(tools[0]!.displayName).toBe("Web Search");
  });

  it("throws AuthenticationError on 401", async () => {
    const mockFetch = createMockFetch({
      "/v1/health": { status: 401, body: "Unauthorized" },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });

    await expect(client.getHealth()).rejects.toThrow(AuthenticationError);
  });

  it("getAgents maps fields correctly", async () => {
    const mockFetch = createMockFetch({
      "/v1/agents": {
        status: 200,
        body: [
          {
            name: "helper",
            display_name: "Helper Agent",
            description: "Helps users",
            is_default: true,
            is_enabled: true,
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const agents = await client.getAgents();

    expect(agents[0]!.displayName).toBe("Helper Agent");
    expect(agents[0]!.isDefault).toBe(true);
  });

  it("submitToolResult posts to /v1/tool-result", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ status: "accepted" }), {
        status: 200,
      });
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await client.submitToolResult({
      conversation_id: "c1",
      message_id: "m1",
      tool_results: [
        {
          call_id: "t1",
          tool_name: "mcp_test",
          result: "done",
          is_error: false,
        },
      ],
    });

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.conversation_id).toBe("c1");
    expect(parsed.tool_results[0].tool_name).toBe("mcp_test");
  });
});
