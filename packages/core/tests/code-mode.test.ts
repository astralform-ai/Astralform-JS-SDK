/**
 * Code mode: a task belongs to a project, and a project list is per app user.
 *
 * The wire fields are the whole contract here — the SDK's types are what a
 * client can see, so a field the mappers or the request builder drop is a field
 * that does not exist as far as the chat app is concerned. These pin each one
 * against the path and payload the backend actually serves.
 */
import { describe, it, expect } from "vitest";
import { AstralformClient } from "../src/client.js";
import { createMockFetch } from "./helpers.js";

const config = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

/** Records every request, and answers each path with its canned body. */
function recordingFetch(
  routes: Record<string, { status?: number; body?: unknown }>,
): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(
          resp.body === undefined ? null : JSON.stringify(resp.body),
          {
            status: resp.status ?? 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetch, calls };
}

describe("code.projects", () => {
  it("lists this user's projects, camelised", async () => {
    const mockFetch = createMockFetch({
      "/v1/code/projects": {
        status: 200,
        body: [
          { repo_full_name: "acme/api", added_at: "2026-09-01T00:00:00Z" },
        ],
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const projects = await client.code.projects.list();

    expect(projects).toEqual([
      { repoFullName: "acme/api", addedAt: "2026-09-01T00:00:00Z" },
    ]);
  });

  it("reads available repositories including the state and the raw total", async () => {
    // `totalCount` counts what the installations cover BEFORE already-added
    // projects are subtracted, so it deliberately exceeds the list's length.
    const mockFetch = createMockFetch({
      "/v1/code/projects/available": {
        status: 200,
        body: {
          state: "ok",
          repositories: [{ full_name: "acme/web", private: true }],
          total_count: 4,
          partial: false,
        },
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const available = await client.code.projects.available();

    expect(available.state).toBe("ok");
    expect(available.repositories).toEqual([
      { fullName: "acme/web", private: true },
    ]);
    expect(available.totalCount).toBe(4);
    expect(available.partial).toBe(false);
  });

  it("keeps an unreachable GitHub distinguishable from an empty one", async () => {
    const mockFetch = createMockFetch({
      "/v1/code/projects/available": {
        status: 200,
        body: { state: "unavailable", repositories: [], total_count: 0 },
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const available = await client.code.projects.available();

    expect(available.state).toBe("unavailable");
    expect(available.repositories).toEqual([]);
    expect(available.partial).toBe(false);
  });

  it("adds a project by full name", async () => {
    const { fetch, calls } = recordingFetch({
      "/v1/code/projects": {
        status: 201,
        body: { repo_full_name: "acme/api", added_at: "2026-09-01T00:00:00Z" },
      },
    });
    const client = new AstralformClient({ ...config, fetch });

    const added = await client.code.projects.add("acme/api");

    expect(added.repoFullName).toBe("acme/api");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/v1/code/projects");
    expect(calls[0].body).toEqual({ repo_full_name: "acme/api" });
  });

  it("removes a project by owner and repo, each segment encoded", async () => {
    const { fetch, calls } = recordingFetch({
      "/v1/code/projects/": { status: 204 },
    });
    const client = new AstralformClient({ ...config, fetch });

    await client.code.projects.remove("acme corp", "api");

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("/v1/code/projects/acme%20corp/api");
  });
});

describe("tasks are conversations with a repository", () => {
  it("parses a conversation's repository, and its absence", async () => {
    const mockFetch = createMockFetch({
      "/v1/conversations": {
        status: 200,
        body: [
          {
            id: "c1",
            title: "fix the flaky test",
            message_count: 2,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-01T00:00:00Z",
            repository: "acme/api",
          },
          {
            id: "c2",
            title: "chat",
            message_count: 1,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-01T00:00:00Z",
            repository: null,
          },
        ],
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const [task, chat] = await client.getConversations();

    expect(task.repository).toBe("acme/api");
    expect(chat.repository).toBeNull();
  });

  it("filters the list to one project's tasks", async () => {
    const { fetch, calls } = recordingFetch({
      "/v1/conversations": { status: 200, body: [] },
    });
    const client = new AstralformClient({ ...config, fetch });

    await client.getConversations(20, 0, { repository: "acme/api" });

    expect(calls[0].url).toContain("limit=20");
    expect(calls[0].url).toContain("repository=acme%2Fapi");
  });

  it("omits the filter entirely when no project is named", async () => {
    const { fetch, calls } = recordingFetch({
      "/v1/conversations": { status: 200, body: [] },
    });
    const client = new AstralformClient({ ...config, fetch });

    await client.getConversations();

    expect(calls[0].url).not.toContain("repository=");
  });

  it("sends the repository on a job request", async () => {
    const { fetch, calls } = recordingFetch({
      "/v1/jobs": {
        status: 201,
        body: {
          job_id: "j1",
          conversation_id: "c1",
          message_id: "m1",
          status: "queued",
        },
      },
    });
    const client = new AstralformClient({ ...config, fetch });

    await client.createJob({ message: "fix it", repository: "acme/api" });

    expect(calls[0].body).toMatchObject({
      message: "fix it",
      repository: "acme/api",
    });
  });
});

describe("agent mode", () => {
  it("reads the mode a client branches on, and tolerates an older server", async () => {
    const mockFetch = createMockFetch({
      "/v1/agents": {
        status: 200,
        body: [
          {
            name: "coder",
            display_name: "Coder",
            description: "",
            is_orchestrator: true,
            is_enabled: true,
            mode: "code",
          },
          {
            name: "legacy",
            display_name: "Legacy",
            description: "",
            is_orchestrator: false,
            is_enabled: true,
          },
        ],
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const [coder, legacy] = await client.getAgents();

    expect(coder.mode).toBe("code");
    // Absent before Astralform 0.70.0 — a client must read that as chat.
    expect(legacy.mode).toBeUndefined();
  });
});

describe("session.send carries the project", () => {
  it("puts SendOptions.repository on the job request", async () => {
    // The request builder in `session.send` is an allowlist: an option it does
    // not name never reaches the wire, however well typed it is. This is the
    // test that would catch that, so it asserts on the POSTed body.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","turn_id":"t1","job_id":"job-1","conversation_id":"c1","message_id":"m1","agent_name":"main","agent_display_name":"Main","seq":0,"ts":0}\n',
      "",
      'event: message_stop\ndata: {"type":"message_stop","turn_id":"t1","job_id":"job-1","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"ttfb_ms":1,"total_ms":2,"stall_count":0,"seq":1,"ts":0}\n',
      "",
      "data: [DONE]\n",
      "",
    ].join("\n");

    const posted: unknown[] = [];
    const base: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/jobs/job-1/events")) {
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/v1/jobs")) {
        posted.push(init?.body ? JSON.parse(init.body as string) : undefined);
        return new Response(
          JSON.stringify({
            job_id: "job-1",
            conversation_id: "c1",
            message_id: "m1",
            status: "queued",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/agent/status")) {
        return new Response(
          JSON.stringify({
            is_ready: true,
            llm_configured: true,
            message: "Ready",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const { ChatSession } = await import("../src/session.js");
    const session = new ChatSession({ ...config, fetch: base });
    await session.connect();
    await session.send("fix the flaky test", { repository: "acme/api" });

    expect(posted[0]).toMatchObject({
      message: "fix the flaky test",
      repository: "acme/api",
    });
  });
});

describe("the published surface", () => {
  it("exports the project types by name", async () => {
    // `index.ts` exports types by explicit name — there is no `export *` — so a
    // type omitted there does not exist for a consumer, however public it looks
    // in `types.ts`. Phase 7 imports these to type its picker.
    const entry = await import("../src/index.js");
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
    );
    for (const name of [
      "CodeProject",
      "AvailableRepository",
      "AvailableRepositories",
    ]) {
      expect(source).toContain(`  ${name},`);
    }
    expect(entry).toBeDefined();
  });

  it("counts nothing rather than undefined when GitHub was never reached", async () => {
    const mockFetch = createMockFetch({
      "/v1/code/projects/available": {
        status: 200,
        body: { state: "unavailable", repositories: [] },
      },
    });
    const client = new AstralformClient({ ...config, fetch: mockFetch });

    const available = await client.code.projects.available();

    expect(available.totalCount).toBe(0);
  });
});

describe("StreamManager.send carries the project", () => {
  it("forwards repository to the session's send options", async () => {
    // StreamManager has its OWN SendOptions, and its forward to session.send is
    // a second allowlist — a field named in only one of the two reaches nothing.
    // The chat client sends through the manager, so this is the path that ships.
    const { StreamManager } = await import("../src/stream-manager.js");
    const forwarded: unknown[] = [];
    const session = {
      conversationId: "c1",
      isStreaming: false,
      messages: [],
      conversations: [],
      createNewConversation: async () => "c1",
      setActiveConversation: () => {},
      invalidateLoadsInFlight: () => {},
      loadConversation: async () => {},
      send: async (_content: string, options?: unknown) => {
        forwarded.push(options);
      },
      on: () => () => {},
      client: {},
    };

    const manager = new StreamManager(
      session as unknown as ConstructorParameters<typeof StreamManager>[0],
    );
    // No switchTo: `send` auto-creates its target, which is the path a first
    // task takes anyway.
    await manager.send("fix the flaky test", {
      repository: "acme/api",
      goal: "open a PR",
      planMode: true,
      agentName: "coder",
      uploadIds: ["u1"],
    });

    // Every field, not just the new one: the defect was the hand-copied
    // allowlist, so pinning one field would leave the next addition free to
    // drop the same way.
    expect(forwarded[0]).toMatchObject({
      conversationId: "c1",
      repository: "acme/api",
      goal: "open a PR",
      planMode: true,
      agentName: "coder",
      uploadIds: ["u1"],
    });
  });
});
