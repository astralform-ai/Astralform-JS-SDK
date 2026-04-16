import { describe, it, expect } from "vitest";
import {
  isEmbeddedResource,
  parseEmbeddedResource,
} from "../src/embedded-resource.js";

describe("isEmbeddedResource", () => {
  it("returns true for objects with _embedded_resource: true", () => {
    expect(
      isEmbeddedResource({
        _embedded_resource: true,
        mime_type: "application/json+a2ui",
        uri: "a2ui://surface/x",
        payload: {},
      }),
    ).toBe(true);
  });

  it("returns false when flag is missing or falsy", () => {
    expect(isEmbeddedResource({ mime_type: "x", uri: "y" })).toBe(false);
    expect(isEmbeddedResource({ _embedded_resource: false })).toBe(false);
    expect(isEmbeddedResource({ _embedded_resource: "true" })).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isEmbeddedResource(null)).toBe(false);
    expect(isEmbeddedResource(undefined)).toBe(false);
    expect(isEmbeddedResource("a string")).toBe(false);
    expect(isEmbeddedResource(42)).toBe(false);
  });
});

describe("parseEmbeddedResource", () => {
  it("parses a well-formed embedded resource", () => {
    const parsed = parseEmbeddedResource({
      _embedded_resource: true,
      mime_type: "application/json+a2ui",
      uri: "a2ui://surface/abc",
      payload: { hello: "world" },
    });
    expect(parsed).toEqual({
      mimeType: "application/json+a2ui",
      uri: "a2ui://surface/abc",
      payload: { hello: "world" },
    });
  });

  it("returns null when the flag is missing", () => {
    expect(
      parseEmbeddedResource({
        mime_type: "application/json+a2ui",
        uri: "a2ui://surface/abc",
        payload: {},
      }),
    ).toBeNull();
  });

  it("returns null when mime_type is missing or empty", () => {
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        uri: "a2ui://x",
        payload: {},
      }),
    ).toBeNull();
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        mime_type: "",
        uri: "a2ui://x",
        payload: {},
      }),
    ).toBeNull();
  });

  it("returns null when uri is missing or empty", () => {
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        mime_type: "application/json+a2ui",
        payload: {},
      }),
    ).toBeNull();
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        mime_type: "application/json+a2ui",
        uri: "",
        payload: {},
      }),
    ).toBeNull();
  });

  it("returns null when payload is missing or not an object", () => {
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        mime_type: "application/json+a2ui",
        uri: "a2ui://x",
      }),
    ).toBeNull();
    expect(
      parseEmbeddedResource({
        _embedded_resource: true,
        mime_type: "application/json+a2ui",
        uri: "a2ui://x",
        payload: "not-an-object",
      }),
    ).toBeNull();
  });
});
