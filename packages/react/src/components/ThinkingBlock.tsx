import { useState } from "react";
import { cn } from "../utils/cn.js";

export interface ThinkingBlockProps {
  content: string;
  isActive: boolean;
  className?: string;
}

export function ThinkingBlock({
  content,
  isActive,
  className,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

  return (
    <div
      className={cn(
        "my-2 rounded-lg border-l-2 border-indigo-500/40 bg-zinc-900/50 px-3 py-2",
        className,
      )}
    >
      {isActive ? (
        <>
          <div className="flex items-center gap-2">
            <svg
              className="h-3.5 w-3.5 animate-pulse text-indigo-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"
              />
            </svg>
            <span className="text-xs font-medium text-indigo-300">
              Thinking...
            </span>
          </div>
          <p className="mt-1.5 text-xs italic text-zinc-500 whitespace-pre-wrap">
            {content}
          </p>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-2 text-left"
          >
            <svg
              className={cn(
                "h-3 w-3 text-zinc-500 transition-transform",
                expanded && "rotate-90",
              )}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 4.5l7.5 7.5-7.5 7.5"
              />
            </svg>
            <span className="text-xs text-zinc-500">Thought process</span>
          </button>
          {expanded && (
            <p className="mt-1.5 text-xs italic text-zinc-500 whitespace-pre-wrap">
              {content}
            </p>
          )}
        </>
      )}
    </div>
  );
}
