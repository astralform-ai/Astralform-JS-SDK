import { cn } from "../utils/cn.js";

export interface AgentBadgeProps {
  agentName: string;
  agentDisplayName?: string;
  avatarUrl?: string;
  className?: string;
}

export function AgentBadge({
  agentName,
  agentDisplayName,
  avatarUrl,
  className,
}: AgentBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-indigo-500/20 px-2.5 py-0.5",
        "text-xs font-medium text-indigo-300 border border-indigo-500/30",
        className,
      )}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={agentDisplayName ?? agentName}
          className="h-3.5 w-3.5 rounded-full object-cover"
        />
      ) : (
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
          />
        </svg>
      )}
      {agentDisplayName ?? agentName}
    </span>
  );
}
