# @astralform/react

React chat UI components for [Astralform](https://astralform.ai). Drop-in chat interface with dark theme, streaming support, multi-agent badges, and tool status indicators.

## Installation

```bash
npm install @astralform/react @astralform/js react react-dom
```

## Prerequisites

This package uses **Tailwind CSS** utility classes. You must have Tailwind CSS configured in your project and include `@astralform/react` in your content paths:

```js
// tailwind.config.js
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@astralform/react/dist/**/*.{js,cjs}",
  ],
  // ...
};
```

## Quick Start

The simplest way to add a full chat UI:

```tsx
import { ChatProvider, ChatContainer } from "@astralform/react";

function App() {
  return (
    <ChatProvider
      config={{
        apiKey: "your-api-key",
        userId: "user-123",
      }}
    >
      <div className="h-screen">
        <ChatContainer />
      </div>
    </ChatProvider>
  );
}
```

## Custom Composition

Use individual components for a custom layout:

```tsx
import {
  ChatProvider,
  useChatContext,
  MessageList,
  MessageInput,
  ConversationSidebar,
} from "@astralform/react";

function CustomChat() {
  const { isStreaming, send } = useChatContext();

  return (
    <div className="flex h-screen">
      <ConversationSidebar />
      <div className="flex flex-1 flex-col">
        <MessageList />
        <MessageInput
          onSend={(content) => send(content)}
          disabled={isStreaming}
        />
      </div>
    </div>
  );
}

function App() {
  return (
    <ChatProvider config={{ apiKey: "your-api-key", userId: "user-123" }}>
      <CustomChat />
    </ChatProvider>
  );
}
```

## Standalone Hook

For full control without the provider pattern:

```tsx
import { useChat } from "@astralform/react";

function Chat() {
  const {
    messages,
    isStreaming,
    streamingContent,
    send,
    isConnected,
  } = useChat({
    apiKey: "your-api-key",
    userId: "user-123",
  });

  if (!isConnected) return <div>Connecting...</div>;

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>{msg.content}</div>
      ))}
      <button onClick={() => send("Hello!")}>Send</button>
    </div>
  );
}
```

## Components

| Component | Description |
|-----------|-------------|
| `ChatProvider` | Context provider that creates and manages a `ChatSession` |
| `ChatContainer` | Complete chat UI with sidebar, messages, and input |
| `ConversationSidebar` | Conversation list with create/delete actions |
| `MessageList` | Scrollable message list with auto-scroll |
| `MessageBubble` | Single message bubble (user or assistant) |
| `MessageInput` | Auto-resizing textarea with send button |
| `ToolStatus` | Tool execution status indicator |
| `AgentBadge` | Agent name pill badge |
| `TypingIndicator` | Animated typing dots |

## Props

### ChatProvider

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `config` | `AstralformConfig` | required | API key, user ID, and optional base URL |
| `storage` | `ChatStorage` | `InMemoryStorage` | Conversation persistence |
| `autoConnect` | `boolean` | `true` | Auto-connect on mount |

### ChatContainer

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `className` | `string` | — | Additional CSS classes |
| `showSidebar` | `boolean` | `true` | Show conversation sidebar |
| `showToolStatus` | `boolean` | `true` | Show tool execution status |

All components accept a `className` prop for customization.

## Customization

All components use Tailwind utility classes that can be overridden via `className` props. The default theme uses a dark color scheme (`bg-zinc-950`, `text-white`, `border-zinc-800`).

## License

MIT
