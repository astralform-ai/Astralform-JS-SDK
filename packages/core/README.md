# @astralform/js

JavaScript/TypeScript SDK for [Astralform](https://astralform.ai) — AI agent orchestration with SSE streaming, client-side tool execution, and [WebMCP](https://developer.chrome.com/docs/extensions/ai/webmcp) bridge support.

## Install

```bash
npm install @astralform/js
```

## Quick Start

```ts
import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
});

session.on((event) => {
  switch (event.type) {
    case "chunk":
      process.stdout.write(event.text);
      break;
    case "complete":
      console.log("\nDone!");
      break;
    case "error":
      console.error(event.error.message);
      break;
  }
});

await session.connect();
await session.send("What is the capital of France?");
session.disconnect();
```

## Features

- **SSE Streaming** — Real-time token-by-token responses via Server-Sent Events
- **Client-Side Tools** — Register tools that the LLM can call, executed locally in your app
- **WebMCP Bridge** — Auto-discovers browser tools from `navigator.modelContext` (Chrome 146+)
- **Multi-Agent** — Route messages to specific agents or let the supervisor choose
- **Conversation Management** — Create, switch, delete, and resume conversations
- **Zero Dependencies** — Uses only native APIs (`fetch`, `ReadableStream`, `crypto`)
- **Universal** — ESM + CJS, works in browsers and Node.js 18+

## Configuration

```ts
import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",   // Required — Astralform project API key
  userId: "user-123",       // Required — identifies the end user
  baseURL: "http://localhost:8000", // Optional — defaults to https://api.astralform.ai
  fetch: customFetch,       // Optional — custom fetch implementation
});
```

## Events

Subscribe to events with `.on()`, which returns an unsubscribe function:

```ts
const unsubscribe = session.on((event) => {
  switch (event.type) {
    case "connected":
      // Session connected, project status and tools loaded
      break;
    case "chunk":
      // Streaming text chunk: event.text
      break;
    case "complete":
      // Response finished: event.content, event.conversationId, event.title
      break;
    case "tool_call":
      // Tool invoked: event.request.toolName, event.request.arguments
      break;
    case "tool_executing":
      // Tool running: event.name
      break;
    case "tool_completed":
      // Tool finished: event.name, event.result
      break;
    case "agent_start":
      // Agent began processing: event.agentName, event.agentDisplayName
      break;
    case "agent_end":
      // Agent finished: event.agentName
      break;
    case "model_info":
      // LLM model identified: event.name
      break;
    case "error":
      // Error occurred: event.error
      break;
    case "disconnected":
      // Session disconnected
      break;
  }
});

// Later: unsubscribe()
```

## Client-Side Tools

Register tools that the LLM can invoke. Tool names **must** start with `mcp_` so the backend routes them to the client for execution.

```ts
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

await session.send("What time is it in Tokyo?");
// The LLM calls mcp_get_current_time → SDK executes it → result sent back → LLM responds
```

The tool execution flow is handled automatically:

1. LLM requests a client tool call via SSE
2. SDK executes the tool handler locally
3. SDK posts the result to `/v1/tool-result`
4. SDK continues the SSE stream for the LLM's final response

## WebMCP Bridge

On Chrome 146+ with WebMCP support, the SDK auto-discovers browser-registered tools:

```ts
await session.connect(); // Automatically calls navigator.modelContext.tools.list()

console.log("WebMCP available:", session.webMCP.isAvailable());
```

You can also register tools that appear in both WebMCP and Astralform:

```ts
session.webMCP.registerTool(
  "page_content",
  "Get the current page content",
  {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector" },
    },
  },
  async (args) => {
    const el = document.querySelector((args.selector as string) || "body");
    return el?.textContent ?? "Not found";
  },
);
```

WebMCP tools are registered with the `mcp_webmcp_` prefix in the tool manifest sent to the backend.

## Multi-Agent

Send messages to specific agents:

```ts
await session.connect();

// List available agents
console.log(session.agents);

// Send to a specific agent
await session.send("Help me debug this", { agentName: "debugger" });
```

## Conversation Management

```ts
// Create a new conversation
const id = await session.createNewConversation();

// Switch to an existing conversation (loads messages from backend)
await session.switchConversation("conversation-id");

// Delete a conversation
await session.deleteConversation("conversation-id");

// Edit and resend from a checkpoint
await session.resendFromCheckpoint("message-id", "Updated message");

// Access state
session.conversationId;   // Current conversation ID
session.conversations;    // All conversations
session.messages;         // Messages in current conversation
```

## Toggle Tools

```ts
// Toggle platform tools (e.g. web search)
session.toggleTool("search"); // Returns true if now enabled, false if disabled

// Toggle MCP tools
session.toggleMcp("github__list_repos");

// Check enabled state
session.enabledTools; // Set<string>
session.enabledMcp;   // Set<string>
```

## Low-Level Client

For direct API access without session state management:

```ts
import { AstralformClient } from "@astralform/js";

const client = new AstralformClient({
  apiKey: "your-api-key",
  userId: "user-123",
});

// REST endpoints
const status = await client.getProjectStatus();
const conversations = await client.getConversations();
const messages = await client.getMessages("conversation-id");
const tools = await client.getTools();
const mcpTools = await client.getMcpTools();
const agents = await client.getAgents();
const skills = await client.getSkills();

// Job-based streaming
const job = await client.createJob({ message: "Hello" });
for await (const event of client.streamJobEvents(job.job_id)) {
  const data = JSON.parse(event.data);
  if (data.type === "content_block_delta") {
    process.stdout.write(data.delta.text);
  }
}
```

## Custom Storage

The SDK uses in-memory storage by default. Implement `ChatStorage` for persistence:

```ts
import { ChatSession, type ChatStorage } from "@astralform/js";

const myStorage: ChatStorage = {
  fetchConversations: async () => { /* ... */ },
  fetchConversation: async (id) => { /* ... */ },
  createConversation: async (id, title) => { /* ... */ },
  updateConversationTitle: async (id, title) => { /* ... */ },
  deleteConversation: async (id) => { /* ... */ },
  fetchMessages: async (conversationId) => { /* ... */ },
  addMessage: async (message, conversationId) => { /* ... */ },
  updateMessageStatus: async (id, status) => { /* ... */ },
  deleteMessage: async (id) => { /* ... */ },
};

const session = new ChatSession(config, myStorage);
```

## Error Handling

The SDK throws typed errors:

```ts
import {
  AuthenticationError,  // 401 — invalid API key
  RateLimitError,       // 429 — rate limit exceeded
  LLMNotConfiguredError, // LLM provider not set up
  ServerError,          // 5xx or unexpected errors
  ConnectionError,      // Network failures
  StreamAbortedError,   // Stream cancelled via disconnect()
} from "@astralform/js";

session.on((event) => {
  if (event.type === "error") {
    if (event.error instanceof AuthenticationError) {
      // Redirect to login
    }
  }
});
```

## Framework Integration

The SDK is headless — it works with any UI framework. Here's a React example:

```tsx
import { ChatSession, type ChatEvent } from "@astralform/js";
import { useEffect, useRef, useState } from "react";

function useChat(apiKey: string, userId: string) {
  const sessionRef = useRef<ChatSession>();
  const [messages, setMessages] = useState<string[]>([]);
  const [streaming, setStreaming] = useState("");

  useEffect(() => {
    const session = new ChatSession({ apiKey, userId });
    sessionRef.current = session;

    session.on((event: ChatEvent) => {
      switch (event.type) {
        case "chunk":
          setStreaming((s) => s + event.text);
          break;
        case "complete":
          setMessages((m) => [...m, event.content]);
          setStreaming("");
          break;
      }
    });

    session.connect();
    return () => session.disconnect();
  }, [apiKey, userId]);

  const send = (text: string) => sessionRef.current?.send(text);

  return { messages, streaming, send };
}
```

## Development

```bash
npm install        # Install dependencies
npm run build      # Build ESM + CJS + types
npm test           # Run tests
npm run typecheck  # Type check
```

## License

MIT
