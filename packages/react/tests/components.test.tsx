import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageBubble } from "../src/components/MessageBubble.js";
import { MessageInput } from "../src/components/MessageInput.js";
import { TypingIndicator } from "../src/components/TypingIndicator.js";
import { AgentBadge } from "../src/components/AgentBadge.js";
import { ToolStatus } from "../src/components/ToolStatus.js";
import type { Message } from "@astralform/js";

describe("MessageBubble", () => {
  const userMessage: Message = {
    id: "msg-1",
    conversationId: "conv-1",
    role: "user",
    content: "Hello, world!",
    status: "complete",
    createdAt: new Date().toISOString(),
  };

  const assistantMessage: Message = {
    id: "msg-2",
    conversationId: "conv-1",
    role: "assistant",
    content: "Hi there! How can I help?",
    status: "complete",
    createdAt: new Date().toISOString(),
  };

  it("renders user message content", () => {
    render(<MessageBubble message={userMessage} />);
    expect(screen.getByText("Hello, world!")).toBeInTheDocument();
  });

  it("renders assistant message content", () => {
    render(<MessageBubble message={assistantMessage} />);
    expect(screen.getByText("Hi there! How can I help?")).toBeInTheDocument();
  });

  it("shows streaming content when streaming", () => {
    render(
      <MessageBubble
        message={assistantMessage}
        isStreaming
        streamingContent="Streaming..."
      />,
    );
    expect(screen.getByText(/Streaming\.\.\./)).toBeInTheDocument();
  });
});

describe("MessageInput", () => {
  it("renders textarea and send button", () => {
    render(<MessageInput onSend={vi.fn()} />);
    expect(
      screen.getByPlaceholderText("Type a message..."),
    ).toBeInTheDocument();
  });

  it("calls onSend when button clicked with content", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("calls onSend on Enter key", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("Hello");
  });

  it("does not send on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send empty messages", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears input after sending", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} />);

    const textarea = screen.getByPlaceholderText(
      "Type a message...",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button"));

    expect(textarea.value).toBe("");
  });

  it("disables input when disabled prop is true", () => {
    render(<MessageInput onSend={vi.fn()} disabled />);
    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toBeDisabled();
  });
});

describe("TypingIndicator", () => {
  it("renders three bouncing dots", () => {
    const { container } = render(<TypingIndicator />);
    const dots = container.querySelectorAll(".animate-bounce");
    expect(dots).toHaveLength(3);
  });
});

describe("AgentBadge", () => {
  it("renders agent display name", () => {
    render(<AgentBadge agentName="search" agentDisplayName="Search Agent" />);
    expect(screen.getByText("Search Agent")).toBeInTheDocument();
  });

  it("falls back to agent name", () => {
    render(<AgentBadge agentName="search" />);
    expect(screen.getByText("search")).toBeInTheDocument();
  });
});

describe("ToolStatus", () => {
  it("renders tool name and executing status", () => {
    render(<ToolStatus toolName="tavily_search" status="executing" />);
    expect(screen.getByText("tavily_search")).toBeInTheDocument();
    expect(screen.getByText("Executing...")).toBeInTheDocument();
  });

  it("renders completed status", () => {
    render(<ToolStatus toolName="tavily_search" status="completed" />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows expandable result", () => {
    render(
      <ToolStatus
        toolName="tavily_search"
        status="completed"
        result="Search results here"
      />,
    );

    const showButton = screen.getByText("Show result");
    fireEvent.click(showButton);

    expect(screen.getByText("Search results here")).toBeInTheDocument();
    expect(screen.getByText("Hide result")).toBeInTheDocument();
  });
});
