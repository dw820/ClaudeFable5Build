"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@/lib/utils";

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn("flex flex-wrap gap-2", className)}
    {...props}
  />
));
ToggleGroup.displayName = "ToggleGroup";

/** Pill: ink-solid when selected, hairline when not (PRD §0c). */
const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & {
    /** Square-ish radius for Aspect/Length pills. */
    square?: boolean;
  }
>(({ className, square, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      "min-h-[44px] cursor-pointer border border-line bg-card px-[15px] py-2 text-sm font-medium text-muted transition-colors",
      square ? "rounded-[9px]" : "rounded-full",
      "hover:border-ink/40",
      "data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:font-semibold data-[state=on]:text-card",
      className,
    )}
    {...props}
  />
));
ToggleGroupItem.displayName = "ToggleGroupItem";

export { ToggleGroup, ToggleGroupItem };
