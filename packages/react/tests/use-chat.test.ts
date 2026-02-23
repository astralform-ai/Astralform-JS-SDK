import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChat } from "../src/hooks/use-chat.js";
import type { AstralformConfig } from "@astralform/js";

// Mock the ChatSession class
vi.mock("@astralform/js", () => {
  const handlers = new Set<(event: unknown) => void>();

  const mockSession = {
    client: {},
    toolRegistry: {},
    webMCP: {},
    storage: {},
    conversationId: null,
    conversations: [],
    messages: [],
    streamingContent: "",
    isStreaming: false,
    executingTool: null,
    projectStatus: null,
    agents: [],
    skills: [],
    platformTools: [],
    mcpTools: [],
    enabledTools: new Set<string>(),
    enabledMcp: new Set<string>(),
    modelDisplayName: null,
    on: vi.fn((handler: (event: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    connect: vi.fn(async () => {
      for (const handler of handlers) {
        handler({ type: "connected" });
      }
    }),
    send: vi.fn(async (_content: string) => {
      mockSession.isStreaming = true;
      mockSession.streamingContent = "Hello!";
      for (const handler of handlers) {
        handler({ type: "chunk", text: "Hello!" });
      }
      mockSession.isStreaming = false;
      mockSession.messages = [
        ...mockSession.messages,
        {
          id: "msg-1",
          conversationId: "conv-1",
          role: "assistant",
          content: "Hello!",
          status: "complete",
          createdAt: new Date().toISOString(),
        },
      ];
      for (const handler of handlers) {
        handler({
          type: "complete",
          content: "Hello!",
          conversationId: "conv-1",
          messageId: "msg-1",
        });
      }
    }),
    createNewConversation: vi.fn(async () => {
      mockSession.conversationId = "new-conv";
      return "new-conv";
    }),
    switchConversation: vi.fn(async (id: string) => {
      mockSession.conversationId = id;
      mockSession.messages = [];
    }),
    deleteConversation: vi.fn(async (id: string) => {
      mockSession.conversations = mockSession.conversations.filter(
        (c: { id: string }) => c.id !== id,
      );
    }),
    toggleTool: vi.fn((name: string) => {
      if (mockSession.enabledTools.has(name)) {
        mockSession.enabledTools.delete(name);
        return false;
      }
      mockSession.enabledTools.add(name);
      return true;
    }),
    toggleMcp: vi.fn((name: string) => {
      if (mockSession.enabledMcp.has(name)) {
        mockSession.enabledMcp.delete(name);
        return false;
      }
      mockSession.enabledMcp.add(name);
      return true;
    }),
    disconnect: vi.fn(() => {
      for (const handler of handlers) {
        handler({ type: "disconnected" });
      }
    }),
  };

  return {
    ChatSession: vi.fn(() => mockSession),
    __mockSession: mockSession,
    __handlers: handlers,
  };
});

const config: AstralformConfig = {
  apiKey: "test-key",
  userId: "test-user",
};

describe("useChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a session and auto-connect", async () => {
    const { result } = renderHook(() => useChat(config));

    // Wait for connect to complete
    await vi.waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
  });

  it("should not auto-connect when autoConnect is false", () => {
    const { result } = renderHook(() =>
      useChat(config, { autoConnect: false }),
    );
    expect(result.current.isConnected).toBe(false);
  });

  it("should send messages", async () => {
    const { result } = renderHook(() => useChat(config));

    await vi.waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    await act(async () => {
      await result.current.send("Hello");
    });

    expect(result.current.session.send).toHaveBeenCalledWith(
      "Hello",
      undefined,
    );
  });

  it("should create new conversations", async () => {
    const { result } = renderHook(() => useChat(config));

    await vi.waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    let id: string | undefined;
    await act(async () => {
      id = await result.current.createNewConversation();
    });

    expect(id).toBe("new-conv");
    expect(result.current.conversationId).toBe("new-conv");
  });

  it("should toggle tools", async () => {
    const { result } = renderHook(() => useChat(config));

    await vi.waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    act(() => {
      result.current.toggleTool("search");
    });

    expect(result.current.enabledTools.has("search")).toBe(true);

    act(() => {
      result.current.toggleTool("search");
    });

    expect(result.current.enabledTools.has("search")).toBe(false);
  });

  it("should handle disconnect", async () => {
    const { result } = renderHook(() => useChat(config));

    await vi.waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.isConnected).toBe(false);
  });
});
