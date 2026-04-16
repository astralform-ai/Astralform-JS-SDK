import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
});

// Register a client-side tool.
// The name MUST start with "mcp_" so the backend routes it to the client.
session.toolRegistry.registerTool(
  "mcp_get_current_time",
  "Get the current date and time",
  {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone (e.g. America/New_York)",
      },
    },
  },
  async (args) => {
    const tz = (args.timezone as string) || "UTC";
    return new Date().toLocaleString("en-US", { timeZone: tz });
  },
);

// v2 emits typed wire events. There is no synthesised `tool_call` — observe
// the block lifecycle directly: the SDK still POSTs the result for you.
session.on((event) => {
  switch (event.type) {
    case "block_start":
      if (event.kind === "tool_use") {
        const fn = event.metadata.function as { name?: string } | undefined;
        console.log(`\n[tool requested] ${fn?.name ?? "(unknown)"}`);
      }
      break;

    case "block_delta":
      if (event.delta.channel === "text") {
        process.stdout.write(event.delta.text);
      }
      break;

    case "block_stop":
      if (event.status === "awaiting_client_result") {
        const toolName = event.final.tool_name as string | undefined;
        console.log(`[tool executing] ${toolName ?? "(unknown)"}`);
      }
      break;

    case "tool_approval_requested":
      // For risky tools, the backend asks for approval before execution.
      // Respond via `client.submitToolApproval({ ... })`.
      console.log(
        `[approval needed] ${event.toolName} (risk=${event.riskLevel})`,
      );
      break;

    case "message_stop":
      console.log(`\n[done] ${event.stopReason}`);
      break;
  }
});

await session.connect();
await session.send("What time is it in Tokyo?");

session.disconnect();
