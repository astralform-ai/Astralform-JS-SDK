/**
 * Groups: a user-named container under one repository, whose sessions share one
 * plan and one set of notes.
 *
 * The wire fields are the whole contract here — a field the mappers or the
 * request builder drop is a field that does not exist as far as the chat app is
 * concerned. These pin each one against the path, method and payload the backend
 * actually serves (phase 1 and 2 of `docs/refactor/workspace-groups` in the
 * Astralform repo).
 *
 * RUNTIME only, like its `code.projects` sibling: `tsconfig.json` excludes
 * `tests` and vitest runs no `typecheck` project, so nothing here pins a TYPE
 * (`camelizeKeys` is structural). `tests/public-exports.test.ts` is what catches
 * a new type left off the export list.
 */
import { describe, it, expect } from "vitest";
import type { Conversation } from "../src/types.js";
import { AstralformClient } from "../src/client.js";

const config = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

const GROUP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONV = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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
        return new Response(resp.body === undefined ? null : JSON.stringify(resp.body), {
          status: resp.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetch, calls };
}

function clientWith(routes: Record<string, { status?: number; body?: unknown }>) {
  const { fetch, calls } = recordingFetch(routes);
  return { client: new AstralformClient({ ...config, fetch }), calls };
}

const groupRow = (over = {}) => ({
  id: GROUP,
  repository: "acme/api",
  title: "Billing rewrite",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  ...over,
});

describe("code.groups", () => {
  it("lists this user's groups, camelised", async () => {
    const { client, calls } = clientWith({ "/v1/code/groups": { body: [groupRow()] } });

    const groups = await client.code.groups.list();

    expect(calls[0].url).toBe("http://localhost:8000/v1/code/groups");
    expect(calls[0].method).toBe("GET");
    expect(groups).toEqual([
      {
        id: GROUP,
        repository: "acme/api",
        title: "Billing rewrite",
        // The mapper is structural, so these are the fields a rename would drop
        // silently — a `created_at` that never reaches the client is a group the
        // sidebar cannot order.
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
  });

  it("narrows to one repository when asked", async () => {
    const { client, calls } = clientWith({ "/v1/code/groups": { body: [] } });

    await client.code.groups.list("acme/api");

    expect(calls[0].url).toBe("http://localhost:8000/v1/code/groups?repository=acme%2Fapi");
  });

  it("omits the query entirely when no repository is given", async () => {
    const { client, calls } = clientWith({ "/v1/code/groups": { body: [] } });

    await client.code.groups.list();

    // The sidebar asks once for every group; a stray `?repository=` would narrow
    // it to nothing.
    expect(calls[0].url).toBe("http://localhost:8000/v1/code/groups");
  });

  it("creates a group with both fields on the wire", async () => {
    const { client, calls } = clientWith({
      "/v1/code/groups": { status: 201, body: groupRow() },
    });

    const created = await client.code.groups.create("acme/api", "Billing rewrite");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ repository: "acme/api", title: "Billing rewrite" });
    expect(created.title).toBe("Billing rewrite");
  });

  it("renames a group", async () => {
    const { client, calls } = clientWith({
      [`/v1/code/groups/${GROUP}`]: { body: groupRow({ title: "Billing v2" }) },
    });

    const renamed = await client.code.groups.rename(GROUP, "Billing v2");

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`http://localhost:8000/v1/code/groups/${GROUP}`);
    expect(calls[0].body).toEqual({ title: "Billing v2" });
    expect(renamed.title).toBe("Billing v2");
  });

  it("deletes a group with a real DELETE", async () => {
    // The reason this namespace exists at all: `del` is private on the client,
    // so no consumer could do this for themselves.
    const { client, calls } = clientWith({ [`/v1/code/groups/${GROUP}`]: { status: 204 } });

    await client.code.groups.remove(GROUP);

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`http://localhost:8000/v1/code/groups/${GROUP}`);
    expect(calls[0].body).toBeUndefined();
  });

  it("files a task into a group and reads the membership back", async () => {
    // 200 with a body, not 204: `post` parses JSON unconditionally, so a No
    // Content reply would be a parse error on a successful write.
    const { client, calls } = clientWith({
      [`/v1/code/groups/${GROUP}/tasks/${CONV}`]: {
        body: { group_id: GROUP, conversation_id: CONV },
      },
    });

    const membership = await client.code.groups.assign(GROUP, CONV);

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `http://localhost:8000/v1/code/groups/${GROUP}/tasks/${CONV}`,
    );
    // No body: the ids are both in the path, where the server's access check can
    // see them. `undefined` is what `send` turns into "no body".
    expect(calls[0].body).toBeUndefined();
    expect(membership).toEqual({ groupId: GROUP, conversationId: CONV });
  });

  it("takes a task out of its group", async () => {
    const { client, calls } = clientWith({
      [`/v1/code/groups/${GROUP}/tasks/${CONV}`]: { status: 204 },
    });

    await client.code.groups.unassign(GROUP, CONV);

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(
      `http://localhost:8000/v1/code/groups/${GROUP}/tasks/${CONV}`,
    );
  });

  it("encodes ids rather than interpolating them raw", async () => {
    // Ids are uuids today, but a path built by concatenation is the shape that
    // breaks the day one is not.
    const { client, calls } = clientWith({ "/v1/code/groups/": { status: 204 } });

    await client.code.groups.remove("a/b c");

    expect(calls[0].url).toBe("http://localhost:8000/v1/code/groups/a%2Fb%20c");
  });
});

describe("Conversation.groupId", () => {
  it("reaches the caller through the conversation list", async () => {
    // `camelizeKeys` copies unknown fields, so this passes on the server's field
    // name alone — which is exactly the contract the chat's allowlist mapper
    // depends on when it names `groupId`.
    const { client } = clientWith({
      "/v1/conversations": {
        body: [
          {
            id: CONV,
            title: "Ship it",
            message_count: 3,
            repository: "acme/api",
            group_id: GROUP,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-02T00:00:00Z",
          },
        ],
      },
    });

    const conversations = await client.getConversations();
    const row = conversations[0] as Conversation;

    expect(row.groupId).toBe(GROUP);
  });

  it("is null-or-absent for an ungrouped task, and neither breaks a reader", async () => {
    const { client } = clientWith({
      "/v1/conversations": {
        body: [
          {
            id: CONV,
            title: "Ship it",
            message_count: 3,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-02T00:00:00Z",
          },
        ],
      },
    });

    const row = (await client.getConversations())[0] as Conversation;

    // Absent from a server older than groups; the chat must treat both the same.
    expect(row.groupId ?? null).toBeNull();
  });
});
