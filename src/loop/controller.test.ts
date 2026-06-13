/**
 * Controller tests — the #1 demo-killer is a loop that doesn't terminate cleanly,
 * so these pin down termination, caps, and best-so-far. (PRD §0b test plan.)
 */
import { describe, it, expect } from "vitest";
import { runLoop, type LoopConfig } from "./controller.js";
import {
  makeStubDeps,
  SAMPLE_LIBRARY,
  VIRAL_RUBRIC,
  DEFAULT_GRADE_SCRIPT,
  type StubOptions,
} from "./stubs.js";
import type { LoopEvent, Grade } from "./types.js";

const INPUT = { brief: "30s Viral Short, open on the wipeout", rubric: VIRAL_RUBRIC, library: SAMPLE_LIBRARY };

function run(config: Partial<LoopConfig> = {}, stub: StubOptions = {}) {
  const events: LoopEvent[] = [];
  const deps = makeStubDeps({ emit: (e) => events.push(e), ...stub });
  return runLoop(INPUT, deps, { maxIters: 4, passThreshold: 7, ...config }).then((result) => ({
    result,
    events,
  }));
}

const allPass: Grade["scores"] = {
  hook_strength: 9, pace_cut_density: 9, caption_legibility: 9, loopability: 9, on_style_trend_fit: 9,
};
const allFail: Grade["scores"] = {
  hook_strength: 3, pace_cut_density: 4, caption_legibility: 3, loopability: 4, on_style_trend_fit: 3,
};

describe("runLoop — termination", () => {
  it("ships on the first passing iteration and stops early", async () => {
    const { result, events } = await run({}, { gradeScript: [allPass] });
    expect(result.passed).toBe(true);
    expect(result.stopReason).toBe("passed");
    expect(result.iterations).toBe(1);
    expect(result.shipped?.iteration).toBe(1);
    // exactly one grade, and a ship event
    expect(events.filter((e) => e.phase === "grade")).toHaveLength(1);
    expect(events.some((e) => e.phase === "ship")).toBe(true);
  });

  it("self-corrects: fails iter 1, passes iter 2 (the demo money-shot)", async () => {
    const { result, events } = await run(); // DEFAULT_GRADE_SCRIPT = weak → pass
    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.shipped?.iteration).toBe(2);
    const grades = events.filter((e) => e.phase === "grade");
    expect(grades[0]?.message).toContain("below threshold");
    expect(grades[1]?.message).toContain("PASS");
    expect(events.some((e) => e.phase === "fix")).toBe(true); // it self-corrected
  });
});

describe("runLoop — caps", () => {
  it("stops at maxIters and ships best-so-far when never passing", async () => {
    const { result } = await run(
      { maxIters: 3 },
      { gradeScript: [allFail, allFail, allFail] },
    );
    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("max-iters");
    expect(result.iterations).toBe(3);
    expect(result.shipped).not.toBeNull(); // never ship nothing
  });

  it("respects the wall-clock cap and still ships best-so-far", async () => {
    let t = 0;
    const now = () => (t += 1000); // each call advances 1s
    const { result } = await run(
      { maxIters: 10, wallclockMs: 1500 },
      { gradeScript: [allFail, allFail, allFail], now },
    );
    expect(result.stopReason).toBe("wallclock");
    expect(result.passed).toBe(false);
    expect(result.shipped).not.toBeNull();
    expect(result.iterations).toBeLessThan(10);
  });

  it("respects the token budget and ships best-so-far", async () => {
    let tokens = 0;
    const spentTokens = () => (tokens += 600);
    const { result } = await run(
      { maxIters: 10, tokenBudget: 1000 },
      { gradeScript: [allFail, allFail, allFail], spentTokens },
    );
    expect(result.stopReason).toBe("token-budget");
    expect(result.shipped).not.toBeNull();
  });
});

describe("runLoop — best-so-far selection", () => {
  it("keeps the highest-scoring render, not the last", async () => {
    const strong: Grade["scores"] = { ...allFail, hook_strength: 6, pace_cut_density: 6, caption_legibility: 6, loopability: 6, on_style_trend_fit: 6 };
    const weak: Grade["scores"] = allFail;
    // iter1 strong (5 near-misses), iter2 weak, iter3 weak → best is iter1
    const { result } = await run(
      { maxIters: 3 },
      { gradeScript: [strong, weak, weak] },
    );
    expect(result.shipped?.iteration).toBe(1);
  });

  it("prefers more passed dimensions over a higher total", async () => {
    const fourPass: Grade["scores"] = { hook_strength: 7, pace_cut_density: 7, caption_legibility: 7, loopability: 7, on_style_trend_fit: 2 };
    const highTotalThreePass: Grade["scores"] = { hook_strength: 10, pace_cut_density: 10, caption_legibility: 10, loopability: 2, on_style_trend_fit: 2 };
    const { result } = await run(
      { maxIters: 2 },
      { gradeScript: [highTotalThreePass, fourPass] },
    );
    expect(result.shipped?.iteration).toBe(2); // 4 passed beats higher total with 3 passed
  });
});

describe("runLoop — resilience", () => {
  it("bounces a schema-invalid EDL without crashing and continues", async () => {
    const { result, events } = await run(
      { maxIters: 3 },
      { invalidEdlOn: [1], gradeScript: [allPass, allPass] },
    );
    expect(result.passed).toBe(true);
    expect(events.some((e) => e.phase === "fix" && e.message.includes("schema"))).toBe(true);
    // iter 1 produced no grade (bounced); pass came later
    expect(result.shipped).not.toBeNull();
  });

  it("survives a render failure and keeps going", async () => {
    const { result, events } = await run(
      { maxIters: 3 },
      { failRenderOn: [1], gradeScript: [allPass, allPass] },
    );
    expect(result.passed).toBe(true);
    expect(events.some((e) => e.phase === "fix" && e.message.includes("Render failed"))).toBe(true);
  });

  it("returns shipped:null only when no render ever succeeded", async () => {
    const { result } = await run(
      { maxIters: 2 },
      { failRenderOn: [1, 2], gradeScript: [allPass, allPass] },
    );
    expect(result.shipped).toBeNull();
    expect(result.stopReason).toBe("max-iters");
  });

  it("carries the fallback flag through to the shipped render", async () => {
    const { result } = await run({}, { gradeScript: [allPass], alwaysFallback: true });
    expect(result.shipped?.render.usedFallback).toBe(true);
  });
});

describe("default grade script", () => {
  it("encodes a weak first cut (fails) then a pass", () => {
    expect(DEFAULT_GRADE_SCRIPT).toHaveLength(2);
    const iter1Fails = Object.values(DEFAULT_GRADE_SCRIPT[0]!).some((s) => s < VIRAL_RUBRIC.passThreshold);
    const iter2Passes = Object.values(DEFAULT_GRADE_SCRIPT[1]!).every((s) => s >= VIRAL_RUBRIC.passThreshold);
    expect(iter1Fails).toBe(true);
    expect(iter2Passes).toBe(true);
  });
});
