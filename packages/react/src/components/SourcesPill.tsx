import { useMemo, useState } from "react";
import { cn } from "../utils/cn.js";
import { hashColor } from "../utils/hash-color.js";

export interface SourcesPillProps {
  sources: Array<{ title: string; url: string }>;
  className?: string;
}

export function SourcesPill({ sources, className }: SourcesPillProps) {
  const [expanded, setExpanded] = useState(false);
  const sourceColors = useMemo(
    () => sources.map((s) => hashColor(s.url, 600)),
    [sources],
  );

  if (sources.length === 0) return null;

  return (
    <div className={cn("my-2", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/80 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700/80 transition-colors"
      >
        <svg
          className="h-3 w-3 text-zinc-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.915-3.282a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757"
          />
        </svg>
        <div className="flex -space-x-1">
          {sources.slice(0, 4).map((source, i) => (
            <div
              key={i}
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white border border-zinc-900",
                sourceColors[i],
              )}
            >
              {source.title.charAt(0).toUpperCase()}
            </div>
          ))}
        </div>
        <span>
          {sources.length} source{sources.length !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 pl-1">
          {sources.map((source, i) => (
            <a
              key={i}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded px-2 py-1 text-xs text-indigo-400 hover:bg-zinc-800/50 hover:text-indigo-300 transition-colors"
            >
              <div
                className={cn(
                  "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white",
                  sourceColors[i],
                )}
              >
                {source.title.charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{source.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
