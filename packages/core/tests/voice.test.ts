import { describe, expect, it, vi } from "vitest";
import { AstralformClient, parseVoicePolishFrame } from "../src/client.js";
import { ConnectionError } from "../src/errors.js";
import { VOICE_POLISH_MODES, isVoiceLLMMode, isVoicePolishMode } from "../src/types.js";
import type { VoicePolishEvent, VoicePolishMode } from "../src/types.js";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function makeClient(fetchFn: typeof globalThis.fetch): AstralformClient {
  return new AstralformClient({
    apiKey: "sk_test",
    userId: "u1",
    baseURL: "http://test.com",
    fetch: fetchFn,
  });
}

describe("getVoiceConfig", () => {
  it("maps the wire shape and fills defaults for absent fields", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, default_mode: "light", hotwords: ["MCP"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const config = await makeClient(fetchFn as unknown as typeof fetch).getVoiceConfig();
    expect(config).toEqual({
      enabled: true,
      modes: ["raw", "light", "structured", "formal"],
      defaultMode: "light",
      silenceAutoStopSeconds: 2,
      autoSend: true,
      maxRecordingSeconds: 300,
      supportsStreaming: false,
      hotwords: ["MCP"],
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test.com/v1/voice/config");
    expect(init.method).toBe("GET");
  });

  it("falls back to structured when the server names a mode this SDK does not know", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, default_mode: "casual", modes: ["casual"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const config = await makeClient(fetchFn as unknown as typeof fetch).getVoiceConfig();
    expect(config.defaultMode).toBe("structured");
    // The picker still sees what the server offers.
    expect(config.modes).toEqual(["casual"]);
  });
});

describe("mode guards", () => {
  it("narrow a config's default mode before polishing", () => {
    expect(VOICE_POLISH_MODES).toEqual(["raw", "light", "structured", "formal"]);
    expect(isVoicePolishMode("formal")).toBe(true);
    expect(isVoicePolishMode("casual")).toBe(false);
    expect(isVoicePolishMode(null)).toBe(false);
    const modes: VoicePolishMode[] = ["raw", "light"];
    expect(modes.filter(isVoiceLLMMode)).toEqual(["light"]);
  });
});

describe("transcribeVoice", () => {
  it("posts one multipart form with the audio, vocabulary and language", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ text: "hello world", language: "en", duration_ms: 500, asr_ms: 42 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = makeClient(fetchFn as unknown as typeof fetch);
    const transcript = await client.transcribeVoice(new Blob(["RIFF...."], { type: "audio/wav" }), {
      hotwords: ["MCP", "Capsule"],
      language: "en",
    });
    expect(transcript).toEqual({ text: "hello world", language: "en", durationMs: 500, asrMs: 42 });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test.com/v1/voice/transcriptions");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("hotwords")).toBe("MCP, Capsule");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("recording.wav");
    // The browser sets the multipart boundary; a JSON Content-Type here would break the upload.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
  });

  it("forwards the caller's signal and surfaces an abort as the runtime's AbortError", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const pending = makeClient(fetchFn as unknown as typeof fetch).transcribeVoice(
      new Blob(["RIFF...."], { type: "audio/wav" }),
      { signal: controller.signal },
    );
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending).rejects.not.toBeInstanceOf(ConnectionError);
  });

  it("passes an abort reason through untouched instead of wrapping it", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = makeClient(fetchFn as unknown as typeof fetch).transcribeVoice(
      new Blob(["RIFF...."], { type: "audio/wav" }),
      { signal: controller.signal },
    );
    const reason = new Error("user cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("streamVoicePolish", () => {
  it("posts the request and yields typed delta / done frames", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        'event: delta\ndata: {"text":"Ship the "}\n\n',
        'event: delta\ndata: {"text":"voice feature."}\n\n',
        'event: done\ndata: {"text":"Ship the voice feature.","polish_ms":840}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events: VoicePolishEvent[] = [];
    for await (const event of makeClient(fetchFn as unknown as typeof fetch).streamVoicePolish({
      text: "um ship the voice feature",
      mode: "structured",
      hotwords: ["MCP"],
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "delta", text: "Ship the " },
      { type: "delta", text: "voice feature." },
      { type: "done", text: "Ship the voice feature.", polishMs: 840 },
    ]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test.com/v1/voice/polish");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "um ship the voice feature",
      mode: "structured",
      hotwords: ["MCP"],
    });
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("surfaces an error frame with the partial and ignores unknown frames", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        'event: delta\ndata: {"text":"Partial "}\n\n',
        "event: ping\ndata: {}\n\n",
        'event: error\ndata: {"reason":"timeout_idle","partial":"Partial "}\n\n',
      ]),
    );
    const events: VoicePolishEvent[] = [];
    for await (const event of makeClient(fetchFn as unknown as typeof fetch).streamVoicePolish({
      text: "x",
      mode: "light",
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "delta", text: "Partial " },
      { type: "error", reason: "timeout_idle", partial: "Partial " },
    ]);
  });
});

describe("parseVoicePolishFrame", () => {
  it("returns null for malformed data and keeps detail only when present", () => {
    expect(parseVoicePolishFrame({ event: "delta", data: "not json" })).toBeNull();
    expect(parseVoicePolishFrame({ event: "delta", data: "{}" })).toBeNull();
    // Valid JSON that is not an object must be skipped, not thrown on.
    expect(parseVoicePolishFrame({ event: "delta", data: "null" })).toBeNull();
    expect(parseVoicePolishFrame({ event: "error", data: "42" })).toBeNull();
    expect(parseVoicePolishFrame({ event: "done", data: "true" })).toBeNull();
    expect(parseVoicePolishFrame({ event: "error", data: "[]" })).toBeNull();
    expect(
      parseVoicePolishFrame({
        event: "error",
        data: JSON.stringify({ reason: "voice_not_ready", partial: "", detail: "Not configured." }),
      }),
    ).toEqual({ type: "error", reason: "voice_not_ready", partial: "", detail: "Not configured." });
  });
});
