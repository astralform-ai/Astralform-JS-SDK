import { useEffect, useRef } from "react";
import { useChatContext } from "../context.js";
import { MessageBubble } from "./MessageBubble.js";
import { TypingIndicator } from "./TypingIndicator.js";
import { AgentBadge } from "./AgentBadge.js";
import { ToolStatus } from "./ToolStatus.js";
import { cn } from "../utils/cn.js";

export interface MessageListProps {
  className?: string;
}

export function MessageList({ className }: MessageListProps) {
  const {
    messages,
    isStreaming,
    streamingContent,
    executingTool,
    activeAgent,
  } = useChatContext();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamingContent, executingTool]);

  return (
    <div className={cn("flex-1 overflow-y-auto px-2 py-4", className)}>
      {messages.length === 0 && !isStreaming && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-zinc-500">
            Send a message to start the conversation
          </p>
        </div>
      )}

      {messages.map((message, index) => {
        const isLast = index === messages.length - 1;
        const showStreaming =
          isLast && isStreaming && message.role === "assistant";
        return (
          <MessageBubble
            key={message.id}
            message={message}
            isStreaming={showStreaming}
            streamingContent={showStreaming ? streamingContent : undefined}
          />
        );
      })}

      {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
        <>
          {activeAgent && (
            <div className="px-4 py-1">
              <AgentBadge agentName={activeAgent} />
            </div>
          )}
          {streamingContent ? (
            <MessageBubble
              message={{
                id: "__streaming__",
                conversationId: "",
                role: "assistant",
                content: streamingContent,
                status: "streaming",
                createdAt: new Date().toISOString(),
              }}
              isStreaming
              streamingContent={streamingContent}
            />
          ) : (
            <TypingIndicator />
          )}
        </>
      )}

      {executingTool && (
        <ToolStatus toolName={executingTool} status="executing" />
      )}

      <div ref={bottomRef} />
    </div>
  );
}
