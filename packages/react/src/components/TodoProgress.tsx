import { useState } from "react";
import type { TodoItem } from "@astralform/js";
import { cn } from "../utils/cn.js";

export interface TodoProgressProps {
  todos: TodoItem[];
  className?: string;
}

export function TodoProgress({ todos, className }: TodoProgressProps) {
  const [expanded, setExpanded] = useState(false);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const pct = Math.round((completed / todos.length) * 100);

  return (
    <div
      className={cn(
        "my-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2"
      >
        <div className="flex-1">
          <div className="h-1.5 rounded-full bg-zinc-800">
            <div
              className="h-1.5 rounded-full bg-indigo-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <span className="text-[11px] text-zinc-500 whitespace-nowrap">
          {completed}/{todos.length}
        </span>
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
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {todos.map((todo, i) => (
            <div key={todo.id ?? i} className="flex items-start gap-2">
              {todo.status === "completed" ? (
                <svg
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-400"
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
              ) : todo.status === "in_progress" ? (
                <svg
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-spin text-indigo-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M21.015 4.356v4.992"
                  />
                </svg>
              ) : (
                <svg
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-zinc-600"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              <span
                className={cn(
                  "text-xs",
                  todo.status === "completed"
                    ? "text-zinc-500 line-through"
                    : todo.status === "in_progress"
                      ? "text-indigo-300"
                      : "text-zinc-300",
                )}
              >
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
