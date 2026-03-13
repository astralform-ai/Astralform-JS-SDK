import { useEffect, useMemo, useRef } from "react";
import { useChatContext } from "../context.js";
import { MessageBubble } from "./MessageBubble.js";
import { TypingIndicator } from "./TypingIndicator.js";
import { AgentBadge } from "./AgentBadge.js";
import { ToolStatus } from "./ToolStatus.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { SubagentCard } from "./SubagentCard.js";
import { CapsuleBlock } from "./CapsuleBlock.js";
import { SourcesPill } from "./SourcesPill.js";
import { TodoProgress } from "./TodoProgress.js";
import { cn } from "../utils/cn.js";

export interface MessageListProps {
  className?: string;
}

const STREAMING_CREATED_AT = new Date(0).toISOString();

export function MessageList({ className }: MessageListProps) {
  const {
    messages,
    isStreaming,
    streamingContent,
    executingTool,
    activeAgent,
    isThinking,
    thinkingContent,
    activeSubagents,
    activeTools,
    capsuleOutputs,
    sources,
    todos,
  } = useChatContext();
  const bottomRef = useRef<HTMLDivElement>(null);

  const contentLength = streamingContent.length;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    messages.length,
    contentLength,
    executingTool,
    activeSubagents.size,
    capsuleOutputs.length,
  ]);

  const pendingTools = useMemo(
    () =>
      Array.from(activeTools.values()).filter((t) => t.status !== "completed"),
    [activeTools],
  );

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

          {(isThinking || thinkingContent) && (
            <ThinkingBlock
              className="mx-4"
              content={thinkingContent}
              isActive={isThinking}
            />
          )}

          {Array.from(activeSubagents.entries()).map(([toolCallId, sub]) => (
            <SubagentCard
              key={toolCallId}
              className="mx-4"
              agentName={sub.agentName}
              displayName={sub.displayName}
              avatarUrl={sub.avatarUrl}
              description={sub.description}
              content={sub.content}
              isActive={sub.isActive}
            />
          ))}

          {pendingTools.map((tool) => (
            <ToolStatus
              key={tool.callId}
              className="mx-4"
              toolName={tool.toolName}
              displayName={tool.displayName}
              status={tool.status}
            />
          ))}

          {capsuleOutputs.map((cap, i) => (
            <CapsuleBlock
              key={i}
              className="mx-4"
              command={cap.command}
              output={cap.output}
              toolName={cap.toolName}
              durationMs={cap.durationMs}
            />
          ))}

          {streamingContent ? (
            <MessageBubble
              message={{
                id: "__streaming__",
                conversationId: "",
                role: "assistant",
                content: streamingContent,
                status: "streaming",
                createdAt: STREAMING_CREATED_AT,
              }}
              isStreaming
              streamingContent={streamingContent}
            />
          ) : (
            !thinkingContent &&
            activeSubagents.size === 0 && <TypingIndicator />
          )}

          {sources.length > 0 && (
            <SourcesPill className="mx-4" sources={sources} />
          )}

          {todos.length > 0 && <TodoProgress className="mx-4" todos={todos} />}
        </>
      )}

      {executingTool && (
        <ToolStatus toolName={executingTool} status="executing" />
      )}

      <div ref={bottomRef} />
    </div>
  );
}
