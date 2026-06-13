/**
 * Unit suite for scene detection. Pure parts only — no ffmpeg.
 */
import { describe, it, expect } from "vitest";
import { parseSceneCuts, buildWindows } from "./scenes.js";

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
