import type { ToolHandler } from "./tools.js";
import { ToolRegistry } from "./tools.js";
import type { WebMCPTool } from "./types.js";

const WEBMCP_PREFIX = "mcp_webmcp_";

export class WebMCPBridge {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  isAvailable(): boolean {
    return (
      typeof navigator !== "undefined" &&
      navigator.modelContext !== undefined &&
      navigator.modelContext !== null
    );
  }

  async discover(): Promise<WebMCPTool[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const tools = await navigator.modelContext!.tools.list();

    for (const tool of tools) {
      const prefixedName = `${WEBMCP_PREFIX}${tool.name}`;
      if (!this.registry.hasTool(prefixedName)) {
        this.registry.registerTool(
          prefixedName,
          tool.description,
          tool.inputSchema,
          async (args) => {
            const result = await navigator.modelContext!.tools.call(
              tool.name,
              args,
            );
            return result.content;
          },
        );
      }
    }

    return tools;
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: ToolHandler,
  ): void {
    const prefixedName = `${WEBMCP_PREFIX}${name}`;

    // Register in ToolRegistry for Astralform backend
    this.registry.registerTool(prefixedName, description, inputSchema, handler);

    // Register in WebMCP if available
    if (this.isAvailable()) {
      navigator.modelContext!.tools.register({
        name,
        description,
        inputSchema,
        handler,
      });
    }
  }

  unregisterTool(name: string): boolean {
    return this.registry.unregisterTool(`${WEBMCP_PREFIX}${name}`);
  }
}
