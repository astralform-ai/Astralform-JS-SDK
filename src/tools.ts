import type { ToolCallRequest, ToolDefinition, ToolResult } from "./types.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

/** Validates tool name: alphanumeric, hyphens, underscores, dots only */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.\-]+$/;

/** Strips prototype-polluting keys from an object */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(args)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    clean[key] = args[key];
  }
  return clean;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  registerTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: ToolHandler,
  ): void {
    if (!name || !TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid tool name "${name}" - must match ${TOOL_NAME_PATTERN}`,
      );
    }
    if (name.length > 256) {
      throw new Error("Tool name must be 256 characters or fewer");
    }
    this.tools.set(name, { name, description, inputSchema, handler });
  }

  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async executeTool(request: ToolCallRequest): Promise<ToolResult> {
    const tool = this.tools.get(request.toolName);
    if (!tool) {
      return {
        call_id: request.callId,
        tool_name: request.toolName,
        result: `Tool "${request.toolName}" not found`,
        is_error: true,
      };
    }

    try {
      const result = await tool.handler(sanitizeArgs(request.arguments));
      return {
        call_id: request.callId,
        tool_name: request.toolName,
        result,
        is_error: false,
      };
    } catch (err) {
      return {
        call_id: request.callId,
        tool_name: request.toolName,
        result: err instanceof Error ? err.message : String(err),
        is_error: true,
      };
    }
  }

  getManifest(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  clear(): void {
    this.tools.clear();
  }
}
