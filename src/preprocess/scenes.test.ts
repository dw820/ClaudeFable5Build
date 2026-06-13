/**
 * Unit suite for scene detection. Pure parts only — no ffmpeg.
 */
import { describe, it, expect } from "vitest";
import { parseSceneCuts, buildWindows, applyBudget, detectScenes } from "./scenes.js";
import type { ExecFn } from "./frameUnderstand.js";

describe("parseSceneCuts", () => {
  it("extracts sorted, de-duped pts_time values from showinfo stderr", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1] n:0 pts:73080 pts_time:3.045 pos:1",
      "[Parsed_showinfo_1 @ 0x1] n:1 pts:228288 pts_time:9.512 pos:2",
      "[Parsed_showinfo_1 @ 0x1] n:2 pts:228288 pts_time:9.512 pos:2",
    ].join("\n");
    expect(parseSceneCuts(stderr)).toEqual([3.045, 9.512]);
  });

  it("returns [] for empty or non-matching input", () => {
    expect(parseSceneCuts("")).toEqual([]);
    expect(parseSceneCuts("no timestamps here")).toEqual([]);
  });
});

describe("buildWindows", () => {
  const opts = { minSceneS: 2, maxSceneS: 15 };

  it("turns cuts into contiguous windows covering [0, duration]", () => {
    const w = buildWindows([3, 9], 12, opts);
    expect(w).toEqual([
      { t0: 0, t1: 3 },
      { t0: 3, t1: 9 },
      { t0: 9, t1: 12 },
    ]);
  });

  it("merges windows shorter than minSceneS into the previous one", () => {
    const w = buildWindows([1, 4], 10, opts);
    expect(w).toEqual([
      { t0: 0, t1: 4 },
      { t0: 4, t1: 10 },
    ]);
  });

  it("subdivides windows longer than maxSceneS into equal sub-windows", () => {
    const w = buildWindows([], 30, opts);
    expect(w).toEqual([
      { t0: 0, t1: 15 },
      { t0: 15, t1: 30 },
    ]);
  });

  it("returns a single whole-clip window for a short clip with no cuts", () => {
    expect(buildWindows([], 8, opts)).toEqual([{ t0: 0, t1: 8 }]);
  });
});

describe("applyBudget", () => {
  it("passes windows through unchanged when within budget", () => {
    const w = [{ t0: 0, t1: 5 }, { t0: 5, t1: 10 }];
    expect(applyBudget(w, 10, 8)).toEqual({ windows: w, coarsened: false });
  });

  it("coarsens to exactly `budget` equal windows covering the whole clip when over", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ t0: i, t1: i + 1 }));
    const { windows, coarsened } = applyBudget(many, 20, 4);
    expect(coarsened).toBe(true);
    expect(windows).toEqual([
      { t0: 0, t1: 5 },
      { t0: 5, t1: 10 },
      { t0: 10, t1: 15 },
      { t0: 15, t1: 20 },
    ]);
  });
});

describe("detectScenes", () => {
  const showinfo = "[Parsed_showinfo_1 @ 0x1] n:0 pts_time:5.0 pos:1";

  it("runs ffmpeg, parses cuts, and builds budgeted windows", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: showinfo });
    const windows = await detectScenes(exec, "clip.mp4", 12, {
      threshold: 0.4, minSceneS: 2, maxSceneS: 15, budget: 60,
    });
    expect(windows).toEqual([{ t0: 0, t1: 5 }, { t0: 5, t1: 12 }]);
  });

  it("falls back to a single whole-clip window when ffmpeg throws", async () => {
    const exec: ExecFn = async () => { throw new Error("ffmpeg missing"); };
    const windows = await detectScenes(exec, "clip.mp4", 9, {
      threshold: 0.4, minSceneS: 2, maxSceneS: 15, budget: 60,
    });
    expect(windows).toEqual([{ t0: 0, t1: 9 }]);
  });
});
