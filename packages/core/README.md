# @astralform/js

JavaScript/TypeScript SDK for [Astralform](https://astralform.ai) — AI agent orchestration with SSE streaming and client-side tool execution.

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
    case "block_delta":
      if (event.delta.channel === "text") {
        process.stdout.write(event.delta.text);
      }
      break;
    case "message_stop":
      console.log("\nDone!");
      break;
    case "error":
      console.error(`${event.code}: ${event.message}`);
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
- **Approval-Gated Tools** — Respond to `tool_approval_requested` events before execution
- **UI Protocols** — Pluggable renderers for MCP-style embedded resources (A2UI, etc.)
- **Multi-Agent** — Route messages to specific agents or let the supervisor choose
- **Conversation Management** — Create, switch, delete, and resume conversations
- **Event Replay** — Translate persisted wire events back into `ChatEvent`s
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

Subscribe to events with `.on()`, which returns an unsubscribe function. The SDK forwards a typed `ChatEvent` for every wire event — consumers build their own block / message state from the stream.

```ts
const unsubscribe = session.on((event) => {
  switch (event.type) {
    case "connected":
      // Session connected, project status and tools loaded
      break;

    // --- Turn lifecycle ---
    case "message_start":
      // New turn: event.turnId, event.model, event.agentDisplayName
      break;
    case "block_start":
      // A content block opened: event.kind ("text" | "thinking" | "tool_use" | ...)
      break;
    case "block_delta":
      // Streaming chunk. Narrow by event.delta.channel:
      //   - "text": event.delta.text
      //   - "thinking": event.delta.text
      //   - "input" / "input_arg": partial tool input
      //   - "output": interpreter stdout/stderr/progress
      //   - "status": "executing" | "awaiting_client_result" | "awaiting_approval" | "denied"
      break;
    case "block_stop":
      // Block finished. event.status === "awaiting_client_result" means
      // a client-side tool is ready to run (see "Client-Side Tools" below).
      break;
    case "message_stop":
      // Turn complete: event.stopReason, event.usage, event.totalMs, event.jobId
      break;

    // --- Custom events (typed variants) ---
    case "subagent_start":
    case "subagent_stop":
      // event.agent (AgentIdentity), event.taskCallId
      break;
    case "todo_update":
      // event.todos (TodoItem[])
      break;
    case "title_generated":
      // event.title
      break;
    case "context_warning":
      // event.severity, event.utilizationPct, event.remainingTokens, ...
      break;
    case "memory_recall":
    case "memory_update":
      // Backend memory subsystem surfaced to the UI
      break;
    case "tool_approval_requested":
      // Respond via client.submitToolApproval(...)
      break;
    case "asset_created":
    case "attachment_staged":
    case "workspace_ready":
    case "desktop_stream":
      // Workspace / asset pipeline events
      break;
    case "state_changed":
      // event.state ("queued" | "running" | "waiting_for_tool" | ...)
      break;
    case "custom":
      // Unknown custom event — forward-compat passthrough
      break;

    // --- Transport / errors ---
    case "retry":
    case "stall":
    case "keepalive":
      break;
    case "error":
      // event.code, event.message, event.blockPath
      break;
    case "disconnected":
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

1. LLM requests a client tool (wire: `block_start(kind="tool_use")`, then streaming `block_delta(channel="input")`)
2. Backend signals ready-to-run with `block_stop(status="awaiting_client_result")` — `final.call_id`, `final.tool_name`, and `final.input` carry the parsed arguments
3. SDK invokes the registered handler locally
4. SDK posts the result to `/v1/tool-result`
5. SDK continues the SSE stream for the LLM's final response

Observers can show "running…" UIs by watching `block_start(kind="tool_use")` and `block_stop(status="awaiting_client_result")` directly.

### Approval-gated tools

When a tool requires user approval, the backend emits a `tool_approval_requested` event instead of proceeding to `awaiting_client_result`. Respond with `client.submitToolApproval(...)`:

```ts
session.on(async (event) => {
  if (event.type === "tool_approval_requested") {
    const ok = confirm(`Allow ${event.toolName}? (${event.reason ?? ""})`);
    await session.client.submitToolApproval({
      job_id: session.currentJobId ?? "",
      call_id: event.callId,
      decision: ok ? "allow" : "deny",
      scope: "once", // "once" | "conversation" | "always"
    });
  }
});
```

## UI Protocols

When the backend renders rich UI surfaces (A2UI today, other protocols in the future), tool output arrives wrapped as an MCP-style embedded resource. Register a framework-specific renderer keyed by MIME type:

```ts
import { ChatSession, parseEmbeddedResource } from "@astralform/js";

await session.connect();

// Gate registration on the project's configured protocol.
if (session.projectStatus?.uiComponents.enabled) {
  session.protocols.register({
    mimeType: session.projectStatus.uiComponents.mimeType!,
    render: (payload) => {
      /* framework-specific render */
    },
  });
}

// Inside your tool-result block handler:
session.on((event) => {
  if (event.type === "block_stop" && event.final) {
    const resource = parseEmbeddedResource(event.final.output);
    if (resource) {
      const adapter = session.protocols.get(resource.mimeType);
      adapter?.render(resource.payload);
    }
  }
});
```

The SDK never imports a renderer — adapters are opaque handles that the consumer narrows on read. Adapters are dropped on `disconnect()`.

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

## Enabling Client Tools

Client tools registered via `session.toolRegistry.registerTool(...)` only run when their name is in the session's enabled set:

```ts
// Enable / disable a registered client tool
session.toggleClientTool("mcp_get_current_time"); // returns true if now enabled

// Inspect the enabled set
session.enabledClientTools; // Set<string>
```

Platform-level features (web search, plan mode) are enabled per-request via the `send` options:

```ts
await session.send("Research the latest on WebGPU", {
  enableSearch: true,
  planMode: true,
});
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
const agents = await client.getAgents();
const skills = await client.getSkills();

// Job-based streaming
const job = await client.createJob({ message: "Hello" });
for await (const event of client.streamJobEvents(job.job_id)) {
  const data = JSON.parse(event.data);
  if (data.type === "block_delta" && data.delta.channel === "text") {
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

HTTP calls (`connect`, `submitToolApproval`, `createJob`, …) throw typed errors:

```ts
import {
  AuthenticationError, // 401 — invalid API key
  RateLimitError, // 429 — rate limit exceeded
  LLMNotConfiguredError, // LLM provider not set up
  ServerError, // 5xx or unexpected errors
  ConnectionError, // Network failures
  StreamAbortedError, // Stream cancelled via disconnect()
} from "@astralform/js";

try {
  await session.connect();
} catch (err) {
  if (err instanceof AuthenticationError) {
    // Redirect to login
  }
}
```

Errors that arrive over the SSE stream fire as a typed `error` event with a structured shape — no `Error` instance is wrapped:

```ts
session.on((event) => {
  if (event.type === "error") {
    // event.code, event.message, event.blockPath
    if (event.code === "rate_limit_exceeded") {
      // Show backoff UI
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
        case "block_delta":
          if (event.delta.channel === "text") {
            setStreaming((s) => s + event.delta.text);
          }
          break;
        case "message_stop":
          setStreaming((s) => {
            setMessages((m) => [...m, s]);
            return "";
          });
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
