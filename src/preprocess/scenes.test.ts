/**
 * Unit suite for scene detection. Pure parts only — no ffmpeg.
 */
import { describe, it, expect } from "vitest";
import { parseSceneCuts } from "./scenes.js";

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
