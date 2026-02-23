import { useState } from "react";
import { cn } from "../utils/cn.js";

export interface ToolStatusProps {
  toolName: string;
  status: "calling" | "executing" | "completed" | "error";
  result?: string;
  className?: string;
}

export function ToolStatus({
  toolName,
  status,
  result,
  className,
}: ToolStatusProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "my-1 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {status === "executing" ? (
          <svg
            className="h-4 w-4 animate-spin text-indigo-400"
            viewBox="0 0 24 24"
            fill="none"
          >
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
        ) : status === "completed" ? (
          <svg
            className="h-4 w-4 text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        ) : status === "error" ? (
          <svg
            className="h-4 w-4 text-red-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        ) : (
          <svg
            className="h-4 w-4 text-zinc-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11.42 15.17l-5.1-5.1m0 0L11.42 4.97m-5.1 5.1H20.5"
            />
          </svg>
        )}

        <span className="font-mono text-zinc-300">{toolName}</span>

        <span className="text-xs text-zinc-500">
          {status === "calling" && "Calling..."}
          {status === "executing" && "Executing..."}
          {status === "completed" && "Completed"}
          {status === "error" && "Failed"}
        </span>

        {result && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="ml-auto text-xs text-zinc-500 hover:text-zinc-300"
          >
            {expanded ? "Hide" : "Show"} result
          </button>
        )}
      </div>

      {expanded && result && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">
          {result}
        </pre>
      )}
    </div>
  );
}
