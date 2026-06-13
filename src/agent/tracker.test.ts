import { describe, it, expect } from "vitest";
import type { Grade, RenderResult } from "../loop/types.js";
import { VIRAL_RUBRIC } from "../loop/stubs.js";
import { Tracker } from "./tracker.js";

const render = (id: string): RenderResult => ({ renderId: id, output: `s://${id}.mp4`, usedFallback: false });
const grade = (id: string, n: number): Grade => ({
  renderId: id,
  scores: { hook_strength: n, pace_cut_density: n, caption_legibility: n, loopability: n, on_style_trend_fit: n },
  feedback: {},
});

describe("Tracker", () => {
  it("keeps the best aggregate (5,8,6 -> 8)", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 5), 1);
    t.record(render("r2"), grade("r2", 8), 2);
    t.record(render("r3"), grade("r3", 6), 3);
    const res = t.summarize("success");
    expect(res.shipped?.render.renderId).toBe("r2");
  });

  it("passed is true only when every dimension meets threshold", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 6), 1);
    expect(t.summarize("success").passed).toBe(false);
    t.record(render("r2"), grade("r2", 7), 2);
    expect(t.summarize("success").passed).toBe(true);
  });

  it("maps SDK terminal subtypes to stopReason", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 7), 1);
    expect(t.summarize("error_max_turns").stopReason).toBe("max-iters");
    expect(t.summarize("error_max_budget_usd").stopReason).toBe("token-budget");
    expect(t.summarize("wallclock").stopReason).toBe("wallclock");
    expect(t.summarize("success").stopReason).toBe("passed");
  });

  it("ships nothing (no-valid-render) when no render was graded", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    const res = t.summarize("success");
    expect(res.shipped).toBeNull();
    expect(res.stopReason).toBe("no-valid-render");
  });
});
