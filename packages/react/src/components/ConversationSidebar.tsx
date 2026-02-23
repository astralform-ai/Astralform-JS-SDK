import { useState } from "react";
import { useChatContext } from "../context.js";
import { cn } from "../utils/cn.js";

export interface ConversationSidebarProps {
  className?: string;
}

export function ConversationSidebar({ className }: ConversationSidebarProps) {
  const {
    conversations,
    conversationId,
    createNewConversation,
    switchConversation,
    deleteConversation,
  } = useChatContext();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  return (
    <div
      className={cn(
        "flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-950",
        className,
      )}
    >
      <div className="border-b border-zinc-800 p-3">
        <button
          type="button"
          onClick={() => createNewConversation()}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg",
            "border border-zinc-700 bg-zinc-900 px-3 py-2",
            "text-sm text-zinc-300 transition-colors",
            "hover:border-zinc-600 hover:bg-zinc-800 hover:text-white",
          )}
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              "group relative mb-1 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer",
              conv.id === conversationId
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
            onClick={() => switchConversation(conv.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") switchConversation(conv.id);
            }}
          >
            <div className="truncate pr-6">
              {conv.title || "New Conversation"}
            </div>
            <div className="mt-0.5 text-xs text-zinc-600">
              {conv.messageCount} messages
            </div>

            {confirmDelete === conv.id ? (
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(conv.id);
                    setConfirmDelete(null);
                  }}
                  className="rounded p-1 text-red-400 hover:bg-red-400/10"
                  title="Confirm delete"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.5 12.75l6 6 9-13.5"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(null);
                  }}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800"
                  title="Cancel"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(conv.id);
                }}
                className={cn(
                  "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1",
                  "text-zinc-600 opacity-0 transition-opacity",
                  "hover:bg-zinc-800 hover:text-zinc-400",
                  "group-hover:opacity-100",
                )}
                title="Delete conversation"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                  />
                </svg>
              </button>
            )}
          </div>
        ))}

        {conversations.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-zinc-600">
            No conversations yet
          </p>
        )}
      </div>
    </div>
  );
}
