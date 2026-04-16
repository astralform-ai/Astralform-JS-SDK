import { ChatSession } from "@astralform/js";

// Browser example — register DOM-backed tools the LLM can invoke.
// The SDK has no built-in WebMCP discovery; register tools explicitly
// via session.toolRegistry (names must start with "mcp_").

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
});

session.toolRegistry.registerTool(
  "mcp_page_content",
  "Get the current page content",
  {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to extract content from",
      },
    },
  },
  async (args) => {
    const selector = (args.selector as string) || "body";
    const el = document.querySelector(selector);
    return el?.textContent ?? "Element not found";
  },
);

await session.connect();

const output = document.getElementById("output")!;

session.on((event) => {
  if (event.type === "block_delta" && event.delta.channel === "text") {
    output.textContent += event.delta.text;
  }
  if (event.type === "message_stop") {
    console.log("Response complete");
  }
});

await session.send("Summarize the content on this page");

session.disconnect();
