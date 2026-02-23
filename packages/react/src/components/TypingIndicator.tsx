import { cn } from "../utils/cn.js";

export interface TypingIndicatorProps {
  className?: string;
}

export function TypingIndicator({ className }: TypingIndicatorProps) {
  return (
    <div className={cn("flex items-center gap-1 px-4 py-3", className)}>
      <span
        className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce"
        style={{ animationDelay: "0ms", animationDuration: "1s" }}
      />
      <span
        className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce"
        style={{ animationDelay: "150ms", animationDuration: "1s" }}
      />
      <span
        className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce"
        style={{ animationDelay: "300ms", animationDuration: "1s" }}
      />
    </div>
  );
}
