import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/tools.js";

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    registry.registerTool(
      "mcp_test",
      "A test tool",
      { type: "object", properties: {} },
      async () => "result",
    );

    expect(registry.hasTool("mcp_test")).toBe(true);
    expect(registry.hasTool("unknown")).toBe(false);
  });

  it("executes a tool successfully", async () => {
    const registry = new ToolRegistry();
    registry.registerTool(
      "mcp_calc",
      "Calculator",
      { type: "object" },
      async (args) => String((args["a"] as number) + (args["b"] as number)),
    );

    const result = await registry.executeTool({
      callId: "c1",
      toolName: "mcp_calc",
      arguments: { a: 2, b: 3 },
      isClientTool: true,
    });

    expect(result.result).toBe("5");
    expect(result.is_error).toBe(false);
    expect(result.call_id).toBe("c1");
  });

  it("returns error for unknown tool", async () => {
    const registry = new ToolRegistry();

    const result = await registry.executeTool({
      callId: "c1",
      toolName: "unknown",
      arguments: {},
      isClientTool: true,
    });

    expect(result.is_error).toBe(true);
    expect(result.result).toContain("not found");
  });

  it("catches handler errors", async () => {
    const registry = new ToolRegistry();
    registry.registerTool("mcp_fail", "Failing tool", {}, async () => {
      throw new Error("oops");
    });

    const result = await registry.executeTool({
      callId: "c1",
      toolName: "mcp_fail",
      arguments: {},
      isClientTool: true,
    });

    expect(result.is_error).toBe(true);
    expect(result.result).toBe("oops");
  });

  it("generates manifest from registered tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool(
      "mcp_a",
      "Tool A",
      { type: "object" },
      async () => "a",
    );
    registry.registerTool(
      "mcp_b",
      "Tool B",
      { type: "object" },
      async () => "b",
    );

    const manifest = registry.getManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0]!.name).toBe("mcp_a");
    expect(manifest[1]!.name).toBe("mcp_b");
  });

  it("unregisters tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool("mcp_x", "X", {}, async () => "x");
    expect(registry.hasTool("mcp_x")).toBe(true);

    registry.unregisterTool("mcp_x");
    expect(registry.hasTool("mcp_x")).toBe(false);
  });

  it("clears all tools", () => {
    const registry = new ToolRegistry();
    registry.registerTool("mcp_a", "A", {}, async () => "a");
    registry.registerTool("mcp_b", "B", {}, async () => "b");

    registry.clear();
    expect(registry.getToolNames()).toHaveLength(0);
  });
});
