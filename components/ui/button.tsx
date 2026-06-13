import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30",
  {
    variants: {
      variant: {
        // Coral — primary actions only (PRD §0c).
        primary:
          "bg-coral text-white font-serif font-semibold shadow-soft hover:bg-[var(--coral-d)]",
        // Ink-outline secondary (the iteration toggle / publish-platform pills).
        outline:
          "border-[1.5px] border-ink bg-card text-ink font-semibold shadow-soft hover:bg-sink",
        ghost: "text-muted hover:bg-sink hover:text-ink",
      },
      size: {
        default: "min-h-[44px] px-4 py-2.5 text-sm",
        lg: "min-h-[44px] px-5 py-3 text-[19px]",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
