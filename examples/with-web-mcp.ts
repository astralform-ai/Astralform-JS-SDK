import { ChatSession } from "@astralform/js";

// WebMCP example - runs in Chrome 146+ with WebMCP support
// Browser-registered tools are automatically discovered and connected

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
});

// Connect - automatically discovers WebMCP tools from navigator.modelContext
await session.connect();

console.log("WebMCP available:", session.webMCP.isAvailable());

// You can also manually register tools that appear in both
// WebMCP (for other AI agents) and Astralform (for your backend agent)
session.webMCP.registerTool(
  "page_content",
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

// All registered tools (including WebMCP-discovered ones)
// are automatically included in the mcp_manifest sent to the backend
session.on((event) => {
  if (event.type === "chunk") {
    // Append to your UI
    document.getElementById("output")!.textContent += event.text;
  }
  if (event.type === "complete") {
    console.log("Response complete");
  }
});

await session.send("Summarize the content on this page");

session.disconnect();
