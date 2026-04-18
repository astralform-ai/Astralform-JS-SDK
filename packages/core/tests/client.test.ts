import { describe, it, expect } from "vitest";
import { AstralformClient } from "../src/client.js";
import {
  AuthenticationError,
  RateLimitError,
  ServerError,
} from "../src/errors.js";
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
          ui_components: {
            enabled: true,
            protocol: "a2ui",
            mime_type: "application/json+a2ui",
          },
        },
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const status = await client.getProjectStatus();

    expect(status.isReady).toBe(true);
    expect(status.llmConfigured).toBe(true);
    expect(status.llmProvider).toBe("openai");
    expect(status.llmModel).toBe("gpt-4o");
    expect(status.uiComponents).toEqual({
      enabled: true,
      protocol: "a2ui",
      mimeType: "application/json+a2ui",
    });
  });

  it("getProjectStatus defaults uiComponents when backend omits the field", async () => {
    const mockFetch = createMockFetch({
      "/v1/project/status": {
        status: 200,
        body: {
          is_ready: true,
          llm_configured: false,
          message: "Missing LLM",
        },
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const status = await client.getProjectStatus();

    expect(status.uiComponents).toEqual({
      enabled: false,
      protocol: null,
      mimeType: null,
    });
  });

  it("submitToolApproval POSTs to /v1/tool-approval with the request body", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      capturedBody = init?.body as string | undefined;
      capturedMethod = init?.method;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await client.submitToolApproval({
      job_id: "job-1",
      call_id: "call-42",
      decision: "allow",
      scope: "once",
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toContain("/v1/tool-approval");
    expect(JSON.parse(capturedBody!)).toEqual({
      job_id: "job-1",
      call_id: "call-42",
      decision: "allow",
      scope: "once",
    });
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

  it("throws AuthenticationError on 401", async () => {
    const mockFetch = createMockFetch({
      "/v1/health": { status: 401, body: "Unauthorized" },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });

    await expect(client.getHealth()).rejects.toThrow(AuthenticationError);
  });

  it("throws RateLimitError with metadata on 429", async () => {
    const nowSec = Math.floor(Date.now() / 1000) + 42;
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "rate_limit_exceeded",
          message: "Too many requests",
          retry_after: 42,
          scope: "project",
          policy_id: "conversation.turn",
          limit: 60,
          remaining: 0,
          reset_at: nowSec,
          request_id: "req_body_123",
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "42",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-Request-ID": "req_header_456",
          },
        },
      );

    const client = new AstralformClient({ ...config, fetch: mockFetch });

    try {
      await client.getHealth();
      throw new Error("Expected getHealth to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rateErr = err as RateLimitError;
      expect(rateErr.message).toBe("Too many requests");
      expect(rateErr.retryAfterSec).toBe(42);
      expect(rateErr.scope).toBe("project");
      expect(rateErr.policyId).toBe("conversation.turn");
      expect(rateErr.limit).toBe(60);
      expect(rateErr.remaining).toBe(0);
      expect(rateErr.requestId).toBe("req_body_123");
      expect(rateErr.resetAt).toBe(nowSec * 1000);
    }
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
            is_orchestrator: true,
            is_enabled: true,
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const agents = await client.getAgents();

    expect(agents[0]!.displayName).toBe("Helper Agent");
    expect(agents[0]!.isOrchestrator).toBe(true);
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

  it("createJob posts to /v1/jobs and returns job response", async () => {
    let capturedUrl = "";
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          job_id: "job-123",
          conversation_id: "c1",
          message_id: "m1",
          status: "queued",
        }),
        { status: 201 },
      );
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const result = await client.createJob({
      message: "Hello",
      conversation_id: "c1",
    });

    expect(capturedUrl).toContain("/v1/jobs");
    expect(result.job_id).toBe("job-123");
    expect(result.conversation_id).toBe("c1");
    expect(result.status).toBe("queued");

    const body = JSON.parse(capturedBody!);
    expect(body.message).toBe("Hello");
  });

  it("cancelJob posts to /v1/jobs/{id}/cancel", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(JSON.stringify({ status: "cancelled" }), {
        status: 200,
      });
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await client.cancelJob("job-123");

    expect(capturedUrl).toContain("/v1/jobs/job-123/cancel");
  });

  it("uploadFile sends multipart FormData", async () => {
    let capturedUrl = "";
    let capturedContentType: string | null = null;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      capturedContentType = headers?.["Content-Type"] ?? null;
      return new Response(
        JSON.stringify({
          id: "upload-1",
          kind: "upload",
          original_name: "test.txt",
          media_type: "text/plain",
          size_bytes: 12,
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200 },
      );
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const blob = new Blob(["hello world!"], { type: "text/plain" });
    const asset = await client.uploadFile("c1", blob, "test.txt");

    expect(capturedUrl).toContain("/v1/conversations/c1/uploads");
    expect(capturedContentType).toBeNull(); // No Content-Type — FormData sets its own
    expect(asset.id).toBe("upload-1");
    expect(asset.originalName).toBe("test.txt");
    expect(asset.sizeBytes).toBe(12);
  });

  it("listUploads returns mapped assets", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations/c1/uploads": {
        status: 200,
        body: [
          {
            id: "u1",
            kind: "upload",
            original_name: "file.pdf",
            media_type: "application/pdf",
            size_bytes: 1024,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const uploads = await client.listUploads("c1");

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.originalName).toBe("file.pdf");
    expect(uploads[0]!.kind).toBe("upload");
  });

  it("listOutputs returns mapped assets", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations/c1/outputs": {
        status: 200,
        body: [
          {
            id: "o1",
            kind: "output",
            original_name: "result.json",
            media_type: "application/json",
            size_bytes: 512,
            agent_name: "helper",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const outputs = await client.listOutputs("c1");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.originalName).toBe("result.json");
    expect(outputs[0]!.kind).toBe("output");
    expect(outputs[0]!.agentName).toBe("helper");
  });

  it("getJob GETs /v1/jobs/{id} and maps snake_case to camelCase", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(
        JSON.stringify({
          job_id: "job-1",
          status: "completed",
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:00:01Z",
          completed_at: "2026-01-01T00:00:05Z",
          error_message: null,
          input_tokens: 120,
          output_tokens: 340,
        }),
        { status: 200 },
      );
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const job = await client.getJob("job-1");

    expect(capturedUrl).toContain("/v1/jobs/job-1");
    expect(job.jobId).toBe("job-1");
    expect(job.status).toBe("completed");
    expect(job.inputTokens).toBe(120);
    expect(job.outputTokens).toBe(340);
    expect(job.startedAt).toBe("2026-01-01T00:00:01Z");
  });

  it("submitFeedback POSTs to /v1/jobs/{id}/feedback", async () => {
    let capturedUrl = "";
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "fb-1",
          job_id: "job-1",
          rating: 1,
          comment: "great",
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 201 },
      );
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const fb = await client.submitFeedback("job-1", {
      rating: 1,
      comment: "great",
    });

    expect(capturedUrl).toContain("/v1/jobs/job-1/feedback");
    expect(JSON.parse(capturedBody!)).toEqual({ rating: 1, comment: "great" });
    expect(fb.id).toBe("fb-1");
    expect(fb.jobId).toBe("job-1");
    expect(fb.rating).toBe(1);
  });

  it("submitFeedback omits the comment key entirely when not provided", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "fb-2",
          job_id: "job-2",
          rating: -1,
          comment: null,
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 201 },
      );
    };

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await client.submitFeedback("job-2", { rating: -1 });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ rating: -1 });
    expect("comment" in parsed).toBe(false);
  });

  it("getActiveJob maps null job_id", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations/c1/active-job": {
        status: 200,
        body: { job_id: null, status: "none" },
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const active = await client.getActiveJob("c1");

    expect(active.jobId).toBeNull();
    expect(active.status).toBe("none");
  });

  it("getActiveJob returns job id when one is active", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations/c1/active-job": {
        status: 200,
        body: { job_id: "job-42", status: "running" },
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const active = await client.getActiveJob("c1");

    expect(active.jobId).toBe("job-42");
    expect(active.status).toBe("running");
  });

  it("listJobs maps fields and handles missing optional keys", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations/c1/jobs": {
        status: 200,
        body: [
          {
            job_id: "job-1",
            status: "completed",
            replaces_job_id: null,
            response_content: { text: "hi" },
            metrics: { total_ms: 1234 },
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            job_id: "job-2",
            status: "failed",
          },
        ],
      },
    });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    const jobs = await client.listJobs("c1");

    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.jobId).toBe("job-1");
    expect(jobs[0]!.metrics).toEqual({ total_ms: 1234 });
    expect(jobs[1]!.replacesJobId).toBeNull();
    expect(jobs[1]!.responseContent).toBeNull();
    expect(jobs[1]!.createdAt).toBeNull();
  });

  it("getJob throws ServerError on 404", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await expect(client.getJob("missing")).rejects.toThrow(ServerError);
  });

  it("submitFeedback throws ServerError on 409 conflict", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ detail: "Feedback already submitted for this job" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    await expect(client.submitFeedback("job-1", { rating: 1 })).rejects.toThrow(
      ServerError,
    );
  });

  it("submitFeedback throws ServerError on 422 invalid rating", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "rating must be -1 or 1" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });

    const client = new AstralformClient({ ...config, fetch: mockFetch });
    // Type-level check blocks this at compile time, but the wire still
    // enforces the rule — pin the runtime behavior.
    await expect(
      client.submitFeedback("job-1", { rating: 2 as unknown as 1 }),
    ).rejects.toThrow(ServerError);
  });
});

/**
 * v1.0.0 added a user-token auth mode for apps acting on behalf of an
 * Astralform account holder (AstralChat, future 3rd-party integrations).
 * The API-key mode above stays 100% unchanged; these tests cover the new
 * surface: discriminated config, per-mode headers, and hot-swap methods.
 */
describe("AstralformClient - user-token mode", () => {
  function captureHeaders() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchFn, calls };
  }

  it("authMode reports the construction mode", () => {
    const apiKeyClient = new AstralformClient({
      apiKey: "sk_test",
      userId: "u1",
    });
    const userClient = new AstralformClient({
      accessToken: "eyJ.jwt",
      projectId: "p1",
    });
    expect(apiKeyClient.authMode).toBe("api_key");
    expect(userClient.authMode).toBe("user_token");
  });

  it("rejects missing accessToken in user-token mode", () => {
    expect(
      () =>
        new AstralformClient({
          accessToken: "",
          projectId: "p1",
        } as never),
    ).toThrow(/accessToken/);
  });

  it("allows pre-pick user-token client without projectId (for discovery routes)", () => {
    // Right after OIDC login the caller has a token but hasn't picked a
    // team/project yet. The client must construct successfully so it can
    // hit account-scoped routes like listTeams() / listProjects(). Project-
    // scoped routes will 4xx until updateProjectId() is called.
    expect(
      () => new AstralformClient({ accessToken: "eyJ.jwt" } as never),
    ).not.toThrow();
  });

  it("rejects missing userId in API-key mode", () => {
    expect(() => new AstralformClient({ apiKey: "sk_test" } as never)).toThrow(
      /userId/,
    );
  });

  it("sends Bearer JWT and X-Project-ID headers (no X-End-User-ID)", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "eyJ.jwt.here",
      projectId: "proj-abc",
      fetch: fetchFn,
    });
    await client.getHealth();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.Authorization).toBe("Bearer eyJ.jwt.here");
    expect(calls[0]!.headers["X-Project-ID"]).toBe("proj-abc");
    expect(calls[0]!.headers["X-End-User-ID"]).toBeUndefined();
  });

  it("updateAccessToken hot-swaps between requests", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "first",
      projectId: "p1",
      fetch: fetchFn,
    });
    await client.getHealth();
    client.updateAccessToken("second");
    await client.getHealth();

    expect(calls[0]!.headers.Authorization).toBe("Bearer first");
    expect(calls[1]!.headers.Authorization).toBe("Bearer second");
  });

  it("updateProjectId swaps X-Project-ID between requests", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "proj-1",
      fetch: fetchFn,
    });
    await client.getHealth();
    client.updateProjectId("proj-2");
    await client.getHealth();

    expect(calls[0]!.headers["X-Project-ID"]).toBe("proj-1");
    expect(calls[1]!.headers["X-Project-ID"]).toBe("proj-2");
  });

  it("updateAccessToken/updateProjectId are not allowed in API-key mode", () => {
    const client = new AstralformClient({
      apiKey: "sk_test",
      userId: "u1",
    });
    expect(() => client.updateAccessToken("x")).toThrow(/user-token mode/);
    expect(() => client.updateProjectId("p")).toThrow(/user-token mode/);
  });

  it("omits X-End-User-ID when endUserId is unset", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
      fetch: fetchFn,
    });
    await client.getHealth();

    expect(calls[0]!.headers["X-End-User-ID"]).toBeUndefined();
    expect(client.endUserId).toBeNull();
  });

  it("sends X-End-User-ID when endUserId is provided at construction", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
      endUserId: "customer-42",
      fetch: fetchFn,
    });
    await client.getHealth();

    expect(calls[0]!.headers["X-End-User-ID"]).toBe("customer-42");
    expect(client.endUserId).toBe("customer-42");
  });

  it("updateEndUserId sets and clears the override between requests", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
      fetch: fetchFn,
    });

    await client.getHealth(); // no override
    client.updateEndUserId("customer-99");
    await client.getHealth(); // with override
    client.updateEndUserId(null);
    await client.getHealth(); // cleared

    expect(calls[0]!.headers["X-End-User-ID"]).toBeUndefined();
    expect(calls[1]!.headers["X-End-User-ID"]).toBe("customer-99");
    expect(calls[2]!.headers["X-End-User-ID"]).toBeUndefined();
  });

  it("updateEndUserId treats empty string as clear", async () => {
    const { fetchFn, calls } = captureHeaders();
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
      endUserId: "start",
      fetch: fetchFn,
    });
    client.updateEndUserId("");
    await client.getHealth();

    expect(calls[0]!.headers["X-End-User-ID"]).toBeUndefined();
    expect(client.endUserId).toBeNull();
  });

  it("updateEndUserId is not allowed in API-key mode", () => {
    const client = new AstralformClient({
      apiKey: "sk_test",
      userId: "u1",
    });
    expect(() => client.updateEndUserId("x")).toThrow(/user-token mode/);
  });

  it("rejects empty updateAccessToken/updateProjectId values", () => {
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
    });
    expect(() => client.updateAccessToken("")).toThrow(/non-empty/);
    expect(() => client.updateProjectId("")).toThrow(/non-empty/);
  });

  it("uploadFile forwards user-token auth headers without Content-Type", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          id: "u1",
          kind: "upload",
          original_name: "a.txt",
          media_type: "text/plain",
          size_bytes: 1,
          created_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200 },
      );
    };
    const client = new AstralformClient({
      accessToken: "tok",
      projectId: "p1",
      fetch: mockFetch,
    });
    await client.uploadFile("c1", new Blob(["x"]), "a.txt");

    expect(capturedHeaders.Authorization).toBe("Bearer tok");
    expect(capturedHeaders["X-Project-ID"]).toBe("p1");
    expect(capturedHeaders["Content-Type"]).toBeUndefined();
  });
});
