import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
});

// Register a client-side tool
// The name MUST start with "mcp_" so the backend routes it to the client
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

// Subscribe to tool execution events
session.on((event) => {
  switch (event.type) {
    case "chunk":
      process.stdout.write(event.text);
      break;
    case "tool_call":
      console.log(`\nTool called: ${event.request.toolName}`);
      break;
    case "tool_executing":
      console.log(`Executing: ${event.name}...`);
      break;
    case "tool_completed":
      console.log(`Result: ${event.result}`);
      break;
    case "complete":
      console.log("\n\nDone!");
      break;
  }
});

await session.connect();

// The LLM can now call mcp_get_current_time when needed
await session.send("What time is it in Tokyo?");

session.disconnect();
