import { useChatContext } from "../context.js";
import { ConversationSidebar } from "./ConversationSidebar.js";
import { MessageList } from "./MessageList.js";
import { MessageInput } from "./MessageInput.js";
import { cn } from "../utils/cn.js";

export interface ChatContainerProps {
  className?: string;
  showSidebar?: boolean;
  showToolStatus?: boolean;
}

export function ChatContainer({
  className,
  showSidebar = true,
}: ChatContainerProps) {
  const { isConnected, isStreaming, error, send, projectStatus } =
    useChatContext();

  if (!isConnected && !error) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center bg-zinc-950 text-zinc-500",
          className,
        )}
      >
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span className="text-sm">Connecting...</span>
        </div>
      </div>
    );
  }

  if (error && !isConnected) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center bg-zinc-950",
          className,
        )}
      >
        <div className="text-center">
          <svg
            className="mx-auto h-8 w-8 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <p className="mt-2 text-sm text-red-400">{error.message}</p>
        </div>
      </div>
    );
  }

  if (projectStatus && !projectStatus.isReady) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center bg-zinc-950",
          className,
        )}
      >
        <div className="text-center">
          <p className="text-sm text-zinc-400">{projectStatus.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full bg-zinc-950", className)}>
      {showSidebar && <ConversationSidebar />}

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
