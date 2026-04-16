import { describe, it, expect } from "vitest";
import {
  ProtocolRegistry,
  type ProtocolAdapter,
} from "../src/protocol-registry.js";

interface FakeAdapter extends ProtocolAdapter {
  render: (payload: Record<string, unknown>) => string;
}

function makeAdapter(mimeType: string, label: string): FakeAdapter {
  return { mimeType, render: (p) => `${label}:${JSON.stringify(p)}` };
}

describe("ProtocolRegistry", () => {
  it("registers, retrieves, and reports presence", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    const a = makeAdapter("application/json+a2ui", "a2ui");

    reg.register(a);

    expect(reg.has("application/json+a2ui")).toBe(true);
    expect(reg.get("application/json+a2ui")).toBe(a);
    expect(reg.get("application/json+unknown")).toBeNull();
  });

  it("register replaces existing adapter for same MIME type", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    const first = makeAdapter("application/json+a2ui", "one");
    const second = makeAdapter("application/json+a2ui", "two");

    reg.register(first);
    reg.register(second);

    expect(reg.get("application/json+a2ui")).toBe(second);
  });

  it("unregister removes an adapter; no-op when absent", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    reg.register(makeAdapter("application/json+a2ui", "x"));

    reg.unregister("application/json+a2ui");
    expect(reg.has("application/json+a2ui")).toBe(false);

    // No throw for missing key
    expect(() => reg.unregister("application/json+missing")).not.toThrow();
  });

  it("listMimeTypes returns registered keys", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    reg.register(makeAdapter("application/json+a2ui", "x"));
    reg.register(makeAdapter("text/markdown", "y"));

    expect(reg.listMimeTypes().sort()).toEqual([
      "application/json+a2ui",
      "text/markdown",
    ]);
  });

  it("clear empties the registry", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    reg.register(makeAdapter("application/json+a2ui", "x"));
    reg.register(makeAdapter("text/markdown", "y"));

    reg.clear();

    expect(reg.listMimeTypes()).toEqual([]);
    expect(reg.has("application/json+a2ui")).toBe(false);
  });

  it("narrows to the generic adapter type without casting on read", () => {
    const reg = new ProtocolRegistry<FakeAdapter>();
    reg.register(makeAdapter("application/json+a2ui", "x"));

    const adapter = reg.get("application/json+a2ui");
    expect(adapter).not.toBeNull();
    // render() exists only on FakeAdapter — proves the generic narrowed
    expect(adapter?.render({ foo: "bar" })).toBe('x:{"foo":"bar"}');
  });
});
