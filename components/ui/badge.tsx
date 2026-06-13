import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md font-semibold leading-none",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--sink)] text-muted",
        pass: "bg-passSoft text-pass",
        fail: "bg-failSoft text-fail",
        amber: "bg-amberSoft text-amber",
        memory: "bg-[#E9F0F8] text-[var(--blue)]",
      },
      size: {
        // phase tag chips in the step feed
        tag: "px-1.5 py-0.5 text-[9.5px] tracking-[0.04em]",
        default: "px-2.5 py-1 text-[11px]",
      },
    },
    defaultVariants: { tone: "neutral", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, size, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
