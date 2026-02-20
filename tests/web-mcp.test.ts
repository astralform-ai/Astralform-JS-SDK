import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebMCPBridge } from "../src/web-mcp.js";
import { ToolRegistry } from "../src/tools.js";

describe("WebMCPBridge", () => {
  let registry: ToolRegistry;
  let bridge: WebMCPBridge;

  beforeEach(() => {
    registry = new ToolRegistry();
    bridge = new WebMCPBridge(registry);
  });

  afterEach(() => {
    // Clean up global mock
    if ("modelContext" in globalThis.navigator) {
      delete (globalThis.navigator as Record<string, unknown>).modelContext;
    }
  });

  it("isAvailable returns false when navigator.modelContext is undefined", () => {
    expect(bridge.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when navigator.modelContext exists", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        modelContext: {
          tools: {
            list: async () => [],
            call: async () => ({ content: "" }),
            register: () => {},
          },
        },
      },
      writable: true,
      configurable: true,
    });

    expect(bridge.isAvailable()).toBe(true);
  });

  it("discover registers WebMCP tools with mcp_webmcp_ prefix", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        modelContext: {
          tools: {
            list: async () => [
              {
                name: "calendar",
                description: "Access calendar",
                inputSchema: { type: "object" },
              },
            ],
            call: async () => ({ content: "events" }),
            register: () => {},
          },
        },
      },
      writable: true,
      configurable: true,
    });

    const tools = await bridge.discover();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("calendar");
    expect(registry.hasTool("mcp_webmcp_calendar")).toBe(true);
  });

  it("registerTool creates dual registration", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        modelContext: {
          tools: {
            list: async () => [],
            call: async () => ({ content: "" }),
            register: () => {},
          },
        },
      },
      writable: true,
      configurable: true,
    });

    bridge.registerTool(
      "my_tool",
      "My tool",
      { type: "object" },
      async () => "result",
    );

    expect(registry.hasTool("mcp_webmcp_my_tool")).toBe(true);
  });

  it("discover returns empty array when not available", async () => {
    const tools = await bridge.discover();
    expect(tools).toHaveLength(0);
  });

  it("unregisterTool removes from registry", () => {
    registry.registerTool("mcp_webmcp_test", "Test", {}, async () => "ok");

    expect(registry.hasTool("mcp_webmcp_test")).toBe(true);
    bridge.unregisterTool("test");
    expect(registry.hasTool("mcp_webmcp_test")).toBe(false);
  });
});
