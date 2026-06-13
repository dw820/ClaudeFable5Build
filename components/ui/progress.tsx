"use client";

import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** 0–100. Drives the bar width. */
  value?: number;
  /** Fill color (token var) — bars climb red→green per dimension pass state. */
  indicatorColor?: string;
}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value = 0, indicatorColor, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-[9px] w-full overflow-hidden rounded-[5px] border border-line bg-[var(--sink)]",
      className,
    )}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full rounded-[4px] transition-[width,background-color] duration-700 ease-[cubic-bezier(.34,1.1,.4,1)]"
      style={{
        width: `${Math.max(0, Math.min(100, value))}%`,
        backgroundColor: indicatorColor ?? "var(--ink)",
      }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = "Progress";

export { Progress };
