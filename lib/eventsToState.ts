/**
 * Pure reducer: fold the ordered stream of `LoopEvent`s the agent writes to
 * Supabase into the view-state the Generation screen renders. No React, no DOM —
 * so it is node-unit-testable and the single source of truth for "what does the
 * scorecard show right now."
 */
import type { LoopEvent, Grade } from "@/lib/contracts";

/**
 * The 5 Viral Short rubric dimensions, as a local runtime constant.
 *
 * Mirrors `RUBRIC_DIMENSIONS` in `@/lib/contracts` (and is type-checked against
 * `Grade["scores"]` below), but is duplicated here on purpose: that module
 * transitively imports the engine via the `@engine/*` alias, which the offline
 * vitest config does not resolve. Keeping the reducer free of runtime engine
 * imports is what makes it node-unit-testable.
 */
const RUBRIC_DIMENSIONS = [
  "hook_strength",
  "pace_cut_density",
  "caption_legibility",
  "loopability",
  "on_style_trend_fit",
] as const satisfies readonly (keyof Grade["scores"])[];

export type RunStatus = "queued" | "running" | "shipped";
export type Verdict = "pass" | "fail" | "pending";

export interface RunState {
  /** The events in order — the left-pane step feed renders these directly. */
  steps: LoopEvent[];
  /** Latest grade-phase scores (drives the climbing scorecard bars). */
  currentScores: Grade["scores"] | null;
  /** Highest iteration number seen across events (1-based). */
  iteration: number;
  status: RunStatus;
  verdict: Verdict;
  /** How many of the 5 dimensions are currently >= the pass floor (7). */
  passedCount: number;
}

/** Per-dimension floor: a dimension passes at >= 7 (PRD §0). */
export const PASS_THRESHOLD = 7;
const DIMENSION_COUNT = RUBRIC_DIMENSIONS.length;

function countPassing(scores: Grade["scores"]): number {
  return RUBRIC_DIMENSIONS.reduce(
    (n, dim) => n + (scores[dim] >= PASS_THRESHOLD ? 1 : 0),
    0,
  );
}

export function eventsToState(events: LoopEvent[]): RunState {
  const steps = [...events].sort((a, b) => a.ts - b.ts);

  let currentScores: Grade["scores"] | null = null;
  let iteration = 0;
  let status: RunStatus = events.length === 0 ? "queued" : "running";

  for (const ev of steps) {
    if (ev.iteration > iteration) iteration = ev.iteration;
    if (ev.phase === "grade" && ev.scores) currentScores = ev.scores;
    if (ev.phase === "ship") status = "shipped";
  }

  const passedCount = currentScores ? countPassing(currentScores) : 0;
  const verdict: Verdict = currentScores
    ? passedCount === DIMENSION_COUNT
      ? "pass"
      : "fail"
    : "pending";

  return { steps, currentScores, iteration, status, verdict, passedCount };
}
