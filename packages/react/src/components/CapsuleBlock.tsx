import { useMemo, useState } from "react";
import { cn } from "../utils/cn.js";

export interface CapsuleBlockProps {
  command?: string;
  output: string;
  toolName: string;
  durationMs?: number;
  className?: string;
}

export function CapsuleBlock({
  command,
  output,
  toolName,
  durationMs,
  className,
}: CapsuleBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { lineCount, isLong, preview } = useMemo(() => {
    const lines = output.split("\n");
    return {
      lineCount: lines.length,
      isLong: lines.length > 5,
      preview: lines.slice(0, 5).join("\n"),
    };
  }, [output]);
  const durationLabel = useMemo(
    () =>
      durationMs
        ? durationMs >= 1000
          ? `${(durationMs / 1000).toFixed(1)}s`
          : `${durationMs}ms`
        : null,
    [durationMs],
  );

  return (
    <div
      className={cn(
        "my-2 rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800/50 px-3 py-1.5">
        <svg
          className="h-3.5 w-3.5 text-zinc-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
          />
        </svg>

        {command ? (
          <code className="flex-1 truncate font-mono text-xs text-emerald-400">
            {command}
          </code>
        ) : (
          <span className="flex-1 truncate font-mono text-xs text-zinc-400">
            {toolName}
          </span>
        )}

        {durationLabel && (
          <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {durationLabel}
          </span>
        )}
      </div>

      <pre className="px-3 py-2 font-mono text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap">
        {expanded ? output : preview}
      </pre>

      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full border-t border-zinc-800/50 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {expanded ? "Show less" : `Show more (${lineCount} lines)`}
        </button>
      )}
    </div>
  );
}
