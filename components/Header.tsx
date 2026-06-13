import Link from "next/link";
import { cn } from "@/lib/utils";

type Screen = "setup" | "generation" | "after";

const TABS: { id: Screen; label: string; href: string }[] = [
  { id: "setup", label: "Setup", href: "/" },
];

/**
 * App header — brand + a nav rail. The Generation/After screens live under one
 * route (/run/[id]) and switch on live status, so nav primarily marks place.
 */
export function Header({ active }: { active: Screen }) {
  return (
    <div className="mb-[18px] flex items-end justify-between">
      <Link href="/" className="flex flex-col">
        <span className="font-serif text-[34px] font-semibold leading-[.95] tracking-[-0.02em] text-ink">
          AutoCut
        </span>
        <span className="mt-[3px] text-[12.5px] text-muted">
          autonomous AI video editor
        </span>
      </Link>
      <nav className="flex gap-1 rounded-[11px] border border-line bg-card p-1 shadow-soft">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            className={cn(
              "rounded-lg px-4 py-2 text-[13px] font-medium text-muted transition-colors",
              active === t.id && "bg-ink font-semibold text-card",
            )}
          >
            {t.label}
          </Link>
        ))}
        <span
          className={cn(
            "rounded-lg px-4 py-2 text-[13px] font-medium",
            active === "generation" || active === "after"
              ? "bg-ink font-semibold text-card"
              : "text-faint",
          )}
        >
          Generation
        </span>
      </nav>
    </div>
  );
}
