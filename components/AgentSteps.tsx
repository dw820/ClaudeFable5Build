"use client";

import type { LoopEvent, LoopPhase } from "@/lib/contracts";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Per-phase presentation: chip tone, uppercase tag, and the leading marker. */
const PHASE_META: Record<
  LoopPhase,
  { tag: string; tone: NonNullable<BadgeProps["tone"]>; mark: string; markClass: string }
> = {
  plan: { tag: "PLAN", tone: "neutral", mark: "•", markClass: "text-faint" },
  memory: { tag: "MEMORY", tone: "memory", mark: "▸", markClass: "text-[var(--blue)]" },
  select: { tag: "SELECT", tone: "neutral", mark: "•", markClass: "text-faint" },
  build: { tag: "BUILD", tone: "neutral", mark: "•", markClass: "text-faint" },
  render: { tag: "RENDER", tone: "neutral", mark: "•", markClass: "text-faint" },
  grade: { tag: "VERIFY", tone: "neutral", mark: "•", markClass: "text-faint" },
  fix: { tag: "FIX", tone: "amber", mark: "↻", markClass: "text-amber" },
  ship: { tag: "SHIP", tone: "pass", mark: "✓", markClass: "text-pass" },
};

/** A grade event renders pass/fail styling from its own scores. */
function gradeMeta(scores: NonNullable<LoopEvent["scores"]>) {
  const passed = Object.values(scores).every((v) => v >= 7);
  return passed
    ? { tone: "pass" as const, mark: "✓", markClass: "text-pass" }
    : { tone: "fail" as const, mark: "✕", markClass: "text-fail" };
}

/** Left pane: the streamed, color-coded agent step timeline. */
export function AgentSteps({ steps }: { steps: LoopEvent[] }) {
  return (
    <div className="min-h-0 overflow-auto border-r border-line p-[18px]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
        Agent steps
      </div>
      <div className="mt-[3px] text-[11px] text-faint">
        streamed live via the Agent SDK
      </div>

      <div className="mt-[14px] flex flex-col gap-[11px]">
        {steps.length === 0 && (
          <div className="text-[12px] text-faint">waiting for the agent…</div>
        )}
        {steps.map((step, i) => {
          const base = PHASE_META[step.phase];
          const g =
            step.phase === "grade" && step.scores
              ? gradeMeta(step.scores)
              : null;
          const tone = g?.tone ?? base.tone;
          const mark = g?.mark ?? base.mark;
          const markClass = g?.markClass ?? base.markClass;
          return (
            <div key={i} className="flex items-start gap-[9px]">
              <span
                className={cn(
                  "mt-px w-[13px] flex-none text-center text-[13px]",
                  markClass,
                )}
              >
                {mark}
              </span>
              <div className="leading-[1.4]">
                <Badge tone={tone} size="tag" className="mr-1.5 align-middle">
                  {base.tag}
                </Badge>
                <span className="text-[13px] text-text">{step.message}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
