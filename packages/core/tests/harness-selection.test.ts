/** Harness identity and unknown feature support across server generations. */
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
  it("getJob maps the wire identity and feature snapshot; absent means null (old server)", async () => {
    const withIdentity = clientOf((async () => new Response(
      JSON.stringify({
        job_id: "job-9",
        status: "completed",
        harness: IDENTITY,
        supported_features: ["goal", "plan"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch);
    const job = await withIdentity.getJob("job-9");
    expect(job.harness).toEqual(IDENTITY);
    expect(job.harness?.release_id).toBe(IDENTITY.release_id);
    expect(job.supportedFeatures).toEqual(["goal", "plan"]);

    const legacy = clientOf((async () => new Response(
      JSON.stringify({ job_id: "job-9", status: "completed" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch);
    const legacyJob = await legacy.getJob("job-9");
    expect(legacyJob.harness).toBeNull();
    expect(legacyJob.supportedFeatures).toBeNull();
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
