import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-card border border-line bg-card shadow-soft",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

/** Faux window chrome bar (the three dots + title) used atop every demo card. */
function CardWindow({
  title,
  className,
  showUrl = false,
}: {
  title?: string;
  className?: string;
  showUrl?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 border-b border-line bg-sink px-[15px] py-[11px]",
        className,
      )}
    >
      <span className="block h-[9px] w-[9px] rounded-full bg-[#D6D2C9]" />
      <span className="block h-[9px] w-[9px] rounded-full bg-[#D6D2C9]" />
      <span className="block h-[9px] w-[9px] rounded-full bg-[#D6D2C9]" />
      {showUrl && (
        <span className="ml-1.5 h-[13px] max-w-[300px] flex-1 rounded-[7px] bg-[var(--sink)]" />
      )}
      {title && (
        <span className="ml-auto text-[11.5px] text-faint">{title}</span>
      )}
    </div>
  );
}

export { Card, CardWindow };
