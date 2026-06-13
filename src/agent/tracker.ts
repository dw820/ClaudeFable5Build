/**
 * Best-so-far tracker for the autonomous agent session.
 *
 * The agent decides what to do; this records every graded render so the harness
 * can ALWAYS ship something, and maps the SDK's terminal `result.subtype` onto
 * the existing `LoopResult.stopReason`. Mirrors the loop controller's candidate
 * ranking (more passing dimensions wins; ties break on total score).
 */
import { RUBRIC_DIMENSIONS, type Grade, type RenderResult } from "../loop/types.js";
import type { LoopResult, Rubric, StopReason } from "../loop/controller.js";

interface Best {
  render: RenderResult;
  grade: Grade;
  iteration: number;
  passedCount: number;
  aggregate: number;
}

export class Tracker {
  private best: Best | null = null;
  private published: string | null = null;
  private maxIteration = 0;

  constructor(private readonly rubric: Rubric) {}

  record(render: RenderResult, grade: Grade, iteration: number): void {
    this.maxIteration = Math.max(this.maxIteration, iteration);
    const passedCount = RUBRIC_DIMENSIONS.filter((d) => grade.scores[d] >= this.rubric.passThreshold).length;
    const aggregate = RUBRIC_DIMENSIONS.reduce((sum, d) => sum + grade.scores[d], 0);
    const better =
      this.best === null ||
      passedCount > this.best.passedCount ||
      (passedCount === this.best.passedCount && aggregate > this.best.aggregate);
    if (better) this.best = { render, grade, iteration, passedCount, aggregate };
  }

  publish(renderId: string): void {
    this.published = renderId;
  }

  get iterations(): number {
    return this.maxIteration;
  }

  summarize(subtype: string): LoopResult {
    const passed = this.best !== null && this.best.passedCount === RUBRIC_DIMENSIONS.length;
    const stopReason: StopReason =
      subtype === "error_max_turns"
        ? "max-iters"
        : subtype === "error_max_budget_usd"
          ? "token-budget"
          : subtype === "wallclock"
            ? "wallclock"
            : this.best !== null
              ? "passed"
              : "no-valid-render";
    return {
      passed,
      iterations: this.maxIteration,
      stopReason,
      shipped: this.best
        ? { render: this.best.render, grade: this.best.grade, iteration: this.best.iteration }
        : null,
    };
  }
}
