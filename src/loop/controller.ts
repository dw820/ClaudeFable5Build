/**
 * Self-correction loop controller (PRD §0b, build task #1).
 *
 * The controller — not the agent — owns iteration, caps, and best-so-far. On
 * Opus 4.8 (not Fable 5) we cannot trust the model to self-terminate cleanly,
 * so termination lives in deterministic, tested code. The builder/render/verify
 * steps are injected dependencies; this file knows nothing about ffmpeg, Claude,
 * or Supabase — only the contract shapes in ./types.
 *
 *   build EDL ──▶ render ──▶ grade ──┬─ pass? ─▶ ship that render
 *      ▲                             │
 *      └──── feedback (fix) ◀────────┘ no, and a cap not hit
 *
 *   caps: maxIters | wallclockMs | tokenBudget  → ship BEST-SO-FAR, never nothing.
 */
import {
  EdlSchema,
  RUBRIC_DIMENSIONS,
  type ClipLibrary,
  type Edl,
  type Grade,
  type LoopEvent,
  type RenderResult,
} from "./types.js";

export interface Rubric {
  style: string;
  /** A dimension passes when its score is >= this. Pass = all dimensions pass. */
  passThreshold: number;
}

export interface BuildContext {
  brief: string;
  rubric: Rubric;
  library: ClipLibrary;
  iteration: number;
  /** Feedback from the previous failing grade, keyed by dimension. */
  previousFeedback?: Grade["feedback"];
  previousEdl?: Edl;
}

export interface LoopDeps {
  /** Builder agent. May return malformed output — the controller validates it. */
  buildEdl: (ctx: BuildContext) => Promise<unknown>;
  /** Deterministic renderer (ffmpeg + Remotion/fallback). */
  render: (edl: Edl) => Promise<RenderResult>;
  /** Independent verifier subagent — sees only the render + rubric. */
  grade: (render: RenderResult, rubric: Rubric) => Promise<Grade>;
  /** Event sink (Supabase writer in production; collector in tests). Optional. */
  emit?: (event: LoopEvent) => void;
  /** Injectable clock for the wall-clock cap and deterministic tests. */
  now?: () => number;
  /** Output tokens spent so far, for the token-budget cap. Optional. */
  spentTokens?: () => number;
}

export interface LoopConfig {
  maxIters: number;
  passThreshold?: number;
  wallclockMs?: number;
  tokenBudget?: number;
}

export type StopReason =
  | "passed"
  | "max-iters"
  | "wallclock"
  | "token-budget"
  | "no-valid-render";

export interface LoopResult {
  passed: boolean;
  iterations: number;
  stopReason: StopReason;
  /** The render we ship: the passing one, or the best-so-far on cap exhaustion. */
  shipped: { render: RenderResult; grade: Grade; iteration: number } | null;
}

interface Candidate {
  render: RenderResult;
  grade: Grade;
  iteration: number;
  passedCount: number;
  aggregate: number;
}

const passedCountOf = (grade: Grade, threshold: number): number =>
  RUBRIC_DIMENSIONS.filter((d) => grade.scores[d] >= threshold).length;

const aggregateOf = (grade: Grade): number =>
  RUBRIC_DIMENSIONS.reduce((sum, d) => sum + grade.scores[d], 0);

/** A candidate is better if it passes more dimensions; ties break on total score. */
const isBetter = (next: Candidate, best: Candidate | null): boolean => {
  if (best === null) return true;
  if (next.passedCount !== best.passedCount) return next.passedCount > best.passedCount;
  return next.aggregate > best.aggregate;
};

export async function runLoop(
  input: { brief: string; rubric: Rubric; library: ClipLibrary },
  deps: LoopDeps,
  config: LoopConfig,
): Promise<LoopResult> {
  const now = deps.now ?? (() => 0);
  const threshold = config.passThreshold ?? input.rubric.passThreshold;
  const startedAt = now();
  const emit = (e: Omit<LoopEvent, "ts">) => deps.emit?.({ ...e, ts: now() });

  let best: Candidate | null = null;
  let previousFeedback: Grade["feedback"] | undefined;
  let previousEdl: Edl | undefined;
  let lastIteration = 0;

  const capHit = (): StopReason | null => {
    if (config.wallclockMs !== undefined && now() - startedAt >= config.wallclockMs) {
      return "wallclock";
    }
    if (
      config.tokenBudget !== undefined &&
      deps.spentTokens !== undefined &&
      deps.spentTokens() >= config.tokenBudget
    ) {
      return "token-budget";
    }
    return null;
  };

  const ship = (passed: boolean, stopReason: StopReason): LoopResult => {
    if (best) {
      emit({
        iteration: best.iteration,
        phase: "ship",
        message: passed
          ? `Ship-ready — passed ${best.passedCount}/${RUBRIC_DIMENSIONS.length} at iteration ${best.iteration}`
          : `Stopped (${stopReason}) — shipping best so far: ${best.passedCount}/${RUBRIC_DIMENSIONS.length} from iteration ${best.iteration}`,
        renderRef: best.render.output,
      });
    }
    return {
      passed,
      iterations: lastIteration,
      stopReason,
      shipped: best
        ? { render: best.render, grade: best.grade, iteration: best.iteration }
        : null,
    };
  };

  for (let iteration = 1; iteration <= config.maxIters; iteration++) {
    lastIteration = iteration;

    // 1. build EDL (validate — the model can hand us garbage)
    emit({ iteration, phase: "build", message: `Building EDL (iteration ${iteration})` });
    const rawEdl = await deps.buildEdl({
      brief: input.brief,
      rubric: input.rubric,
      library: input.library,
      iteration,
      previousFeedback,
      previousEdl,
    });
    const parsed = EdlSchema.safeParse(rawEdl);
    if (!parsed.success) {
      emit({
        iteration,
        phase: "fix",
        message: `EDL rejected by schema: ${parsed.error.issues[0]?.message ?? "invalid"} — bouncing back to builder`,
      });
      previousFeedback = { _edl: "previous EDL was schema-invalid; fix structure" };
      if (capHit()) return ship(false, capHit()!);
      continue; // bounce — counts as an iteration, no render
    }
    const edl = parsed.data;
    previousEdl = edl;

    // 2. render
    let render: RenderResult;
    try {
      render = await deps.render(edl);
      emit({
        iteration,
        phase: "render",
        message: render.usedFallback
          ? "Rendered (Remotion overlay failed → ffmpeg caption fallback)"
          : "Rendered (Remotion overlay)",
        renderRef: render.output,
      });
    } catch (err) {
      emit({
        iteration,
        phase: "fix",
        message: `Render failed: ${err instanceof Error ? err.message : String(err)} — keeping prior best`,
      });
      if (capHit()) return ship(false, capHit()!);
      continue;
    }

    // 3. grade (independent verifier)
    const grade = await deps.grade(render, input.rubric);
    const passedCount = passedCountOf(grade, threshold);
    const passed = passedCount === RUBRIC_DIMENSIONS.length;
    emit({
      iteration,
      phase: "grade",
      message: `Director graded ${passedCount}/${RUBRIC_DIMENSIONS.length} — ${passed ? "PASS" : "below threshold"}`,
      scores: grade.scores,
      renderRef: render.output,
    });

    // 4. best-so-far
    const candidate: Candidate = {
      render,
      grade,
      iteration,
      passedCount,
      aggregate: aggregateOf(grade),
    };
    if (isBetter(candidate, best)) best = candidate;

    // 5. pass → ship; else feed back + check caps
    if (passed) {
      emit({ iteration, phase: "memory", message: "Distilling 1 rule to memory" });
      return ship(true, "passed");
    }
    emit({
      iteration,
      phase: "fix",
      message: `Self-correcting: ${Object.values(grade.feedback)[0] ?? "adjusting EDL"}`,
    });
    previousFeedback = grade.feedback;

    const reason = capHit();
    if (reason) return ship(false, reason);
  }

  return ship(false, "max-iters");
}
