"use client";

import type { Grade } from "@/lib/contracts";
import { RUBRIC_DIMENSIONS } from "@/lib/contracts";
import type { RubricDimension } from "@engine/loop/types";
import { Progress } from "@/components/ui/progress";
import { PASS_THRESHOLD, type Verdict } from "@/lib/eventsToState";
import { cn } from "@/lib/utils";

/** Human labels for the 5 rubric dimensions. */
const DIM_LABELS: Record<RubricDimension, string> = {
  hook_strength: "Hook strength",
  pace_cut_density: "Pace / cut density",
  caption_legibility: "Caption legibility",
  loopability: "Loopability",
  on_style_trend_fit: "On-style / trend",
};

const MAX_ITERS = 4;

/** Right rail: the rubric scorecard — 5 bars climbing red→green + verdict. */
export function Scorecard({
  scores,
  iteration,
  verdict,
  passedCount,
}: {
  scores: Grade["scores"] | null;
  iteration: number;
  verdict: Verdict;
  passedCount: number;
}) {
  const passed = verdict === "pass";

  return (
    <div className="min-h-0 overflow-auto bg-sink p-[18px]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
        Rubric scorecard
      </div>
      <div className="my-[3px] font-serif text-[18px] text-ink">
        Iteration {Math.max(iteration, 1)} of {MAX_ITERS}
      </div>
      <div className="mb-4 text-[11px] text-faint">
        verifier sees video + rubric only
      </div>

      <div>
        {RUBRIC_DIMENSIONS.map((dim) => {
          const score = scores?.[dim] ?? 0;
          const dimPass = score >= PASS_THRESHOLD;
          const color = dimPass ? "var(--pass)" : "var(--fail)";
          return (
            <div key={dim} className="mb-3 flex items-center gap-[9px]">
              <span
                className="w-[15px] text-center text-[13px] font-bold"
                style={{ color: scores ? color : "var(--faint)" }}
              >
                {scores ? (dimPass ? "✓" : "✕") : "·"}
              </span>
              <div className="flex-1">
                <div className="mb-1 flex justify-between text-[12px] text-text">
                  <span>{DIM_LABELS[dim]}</span>
                  <span className="text-faint tnum">{score}/10</span>
                </div>
                <Progress
                  value={score * 10}
                  indicatorColor={scores ? color : "var(--sink)"}
                  aria-label={`${DIM_LABELS[dim]} ${score} of 10`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          "mt-[14px] rounded-[11px] border-[1.5px] p-[11px] text-center",
          verdict === "pending" && "border-line",
        )}
        style={
          verdict === "pending"
            ? undefined
            : {
                borderColor: passed ? "var(--pass)" : "var(--fail)",
                background: passed ? "var(--pass-soft)" : "var(--fail-soft)",
              }
        }
      >
        <div
          className="font-serif text-[20px] font-bold"
          style={{
            color: passed
              ? "var(--pass)"
              : verdict === "fail"
                ? "var(--fail)"
                : "var(--muted)",
          }}
        >
          {verdict === "pending"
            ? "GRADING…"
            : passed
              ? "PASS · ship-ready"
              : "FAIL · self-correct"}
        </div>
        <div className="mt-px text-[11px] text-muted">
          {passedCount} / {RUBRIC_DIMENSIONS.length} dimensions ≥ {PASS_THRESHOLD}
        </div>
      </div>

      <div className="mt-[7px] text-center text-[10px] text-faint">
        caps: ≤{MAX_ITERS} iters · best-so-far always kept
      </div>
    </div>
  );
}
