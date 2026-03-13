import { useMemo, useState } from "react";
import { cn } from "../utils/cn.js";
import { hashColor } from "../utils/hash-color.js";

export interface SubagentCardProps {
  agentName: string;
  displayName: string;
  avatarUrl?: string;
  description?: string;
  content: string;
  isActive: boolean;
  className?: string;
}

export function SubagentCard({
  agentName,
  displayName,
  avatarUrl,
  description,
  content,
  isActive,
  className,
}: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(
    () => (content.length > 200 ? content.slice(-200) : content),
    [content],
  );

  return (
    <div
      className={cn(
        "my-2 ml-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2",
        isActive && "border-indigo-500/30",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-5 w-5 rounded-full object-cover"
          />
        ) : (
          <div
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white",
              hashColor(agentName),
            )}
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}

        <span className="text-xs font-medium text-zinc-300">{displayName}</span>

        {isActive ? (
          <span className="flex items-center gap-1 text-[10px] text-indigo-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            Working
          </span>
        ) : (
          <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-400">
            Done
          </span>
        )}
      </div>

      {description && (
        <p className="mt-1 text-[11px] text-zinc-500">{description}</p>
      )}

      {content &&
        (isActive ? (
          <p className="mt-1.5 text-xs text-zinc-400 whitespace-pre-wrap">
            {preview}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-1.5 text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              {expanded ? "Hide output" : "Show output"}
            </button>
            {expanded && (
              <p className="mt-1 text-xs text-zinc-400 whitespace-pre-wrap">
                {content}
              </p>
            )}
          </>
        ))}
    </div>
  );
}
