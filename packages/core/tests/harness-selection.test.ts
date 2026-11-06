/**
 * Harness selection on the job surface (phase 3C):
 * - `createJob` forwards `harness_release_id`/`harness_configuration` verbatim
 *   and returns the admitted `harness` identity.
 * - `getJob` maps the wire `harness` object; absent on old servers -> null.
 */
import { describe, expect, it } from "vitest";
import { AstralformClient } from "../src/client.js";
import type { HarnessIdentity } from "../src/types.js";

const IDENTITY: HarnessIdentity = {
  session_id: "54bfd7c2-6ec2-4d24-a1e5-7ee1b1d1b06a",
  release_id: "2578998f-f236-4edf-8721-8c7138db4e01",
  profile: "dsh",
  legacy_native: false,
};

const config = {
  apiKey: "test-key",
  baseURL: "http://localhost:8000",
  userId: "user-1",
};

function clientOf(fetchImpl: typeof globalThis.fetch): AstralformClient {
  return new AstralformClient({ ...config, fetch: fetchImpl });
}

describe("harness selection", () => {
  it("createJob forwards the initial selection and returns the admitted identity", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = clientOf((async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          job_id: "job-1",
          conversation_id: "conv-1",
          message_id: "msg-1",
          status: "queued",
          harness: IDENTITY,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);

    const created = await client.createJob({
      message: "hello",
      provider: "openrouter",
      model: "m",
      harness_release_id: IDENTITY.release_id!,
      harness_configuration: { mode: "edit" },
    });

    expect(capturedBody?.harness_release_id).toBe(IDENTITY.release_id);
    expect(capturedBody?.harness_configuration).toEqual({ mode: "edit" });
    expect(created.harness).toEqual(IDENTITY);
  });

  it("createJob omits the selection keys entirely when not chosen", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = clientOf((async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          job_id: "j",
          conversation_id: "c",
          message_id: "m",
          status: "queued",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch);

    await client.createJob({ message: "hi", provider: "p", model: "m" });
    expect(capturedBody).not.toHaveProperty("harness_release_id");
    expect(capturedBody).not.toHaveProperty("harness_configuration");
  });

  it("getJob maps the wire harness identity; absent means null (old server)", async () => {
    const withIdentity = clientOf((async () => new Response(
      JSON.stringify({ job_id: "job-9", status: "completed", harness: IDENTITY }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch);
    const job = await withIdentity.getJob("job-9");
    expect(job.harness).toEqual(IDENTITY);
    expect(job.harness?.release_id).toBe(IDENTITY.release_id);

    const legacy = clientOf((async () => new Response(
      JSON.stringify({ job_id: "job-9", status: "completed" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch);
    expect((await legacy.getJob("job-9")).harness).toBeNull();
  });

  it("legacy-native identity carries a null release id without breaking the type", async () => {
    const legacyNative = clientOf((async () => new Response(
      JSON.stringify({
        job_id: "job-old",
        status: "completed",
        harness: {
          session_id: "s",
          release_id: null,
          profile: "astralform",
          legacy_native: true,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch);
    const job = await legacyNative.getJob("job-old");
    expect(job.harness?.legacy_native).toBe(true);
    expect(job.harness?.release_id).toBeNull();
  });
});
