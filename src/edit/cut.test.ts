/**
 * Unit tests for the cut half (Lane A) — NO ffmpeg exec, runs fully offline.
 *
 * Pins the pure filtergraph: per-segment trim/scale/pad, lut3d gating,
 * concat vs xfade spine with correct overlap offsets, aspect→WxH mapping,
 * and the over-length flag via the shared edlDurationS helper.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { ClipLibrarySchema, EdlSchema, type ClipLibrary, type Edl } from "../loop/types.js";
import { CROSSFADE_S, TARGET_LEN_TOLERANCE_S, edlDurationS } from "../constants.js";
import { ASPECT_DIMENSIONS, buildFfmpegArgs, mediaDir } from "./ffmpegArgs.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "__fixtures__");
const load = <T>(f: string): T => JSON.parse(readFileSync(join(fixtures, f), "utf8")) as T;

const SAMPLE_EDL: Edl = EdlSchema.parse(load("sample-edl.json"));
const SAMPLE_CLIPS: ClipLibrary = ClipLibrarySchema.parse(load("sample-clips.json"));

const OUT = "/tmp/out.mp4";

/** Extract the single -filter_complex value from an argv array. */
function filterOf(args: string[]): string {
  const i = args.indexOf("-filter_complex");
  expect(i).toBeGreaterThanOrEqual(0);
  return args[i + 1]!;
}

describe("buildFfmpegArgs — geometry", () => {
  it("maps each aspect to the correct output WxH", () => {
    expect(ASPECT_DIMENSIONS["9:16"]).toEqual({ w: 1080, h: 1920 });
    expect(ASPECT_DIMENSIONS["1:1"]).toEqual({ w: 1080, h: 1080 });
    expect(ASPECT_DIMENSIONS["16:9"]).toEqual({ w: 1920, h: 1080 });
  });

  it("returns computed width/height for the EDL aspect (9:16 sample)", () => {
    const plan = buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT);
    expect(plan.width).toBe(1080);
    expect(plan.height).toBe(1920);
  });

  it.each(["9:16", "1:1", "16:9"] as const)("scale+pad target matches %s", (aspect) => {
    const edl: Edl = { ...SAMPLE_EDL, aspect };
    const { w, h } = ASPECT_DIMENSIONS[aspect];
    const filter = filterOf(buildFfmpegArgs(edl, SAMPLE_CLIPS, OUT).args);
    expect(filter).toContain(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
    expect(filter).toContain(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);
  });
});

describe("buildFfmpegArgs — inputs + trim", () => {
  it("emits one -i per segment, resolved against MEDIA_DIR", () => {
    const plan = buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT);
    const inputFlags = plan.args.filter((a) => a === "-i");
    expect(inputFlags).toHaveLength(SAMPLE_EDL.segments.length);

    // First segment is c01 → media/clips/wipeout.mp4, joined under mediaDir().
    expect(plan.inputs[0]).toBe(join(mediaDir(), "media/clips/wipeout.mp4"));
    expect(plan.inputs).toHaveLength(SAMPLE_EDL.segments.length);
  });

  it("trims each segment with its in/out and resets PTS", () => {
    const filter = filterOf(buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args);
    SAMPLE_EDL.segments.forEach((seg, i) => {
      expect(filter).toContain(`[${i}:v]trim=start=${seg.in}:end=${seg.out}`);
    });
    expect(filter).toContain("setpts=PTS-STARTPTS");
  });

  it("honors MEDIA_DIR override", () => {
    const prev = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = "/data/media";
    try {
      const plan = buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT);
      expect(plan.inputs[0]).toBe("/data/media/media/clips/wipeout.mp4");
    } finally {
      if (prev === undefined) delete process.env.MEDIA_DIR;
      else process.env.MEDIA_DIR = prev;
    }
  });

  it("throws on a dangling clipId", () => {
    const bad: Edl = {
      ...SAMPLE_EDL,
      segments: [{ ...SAMPLE_EDL.segments[0]!, clipId: "does-not-exist" }],
    };
    expect(() => buildFfmpegArgs(bad, SAMPLE_CLIPS, OUT)).toThrow(/unknown clipId/);
  });
});

describe("buildFfmpegArgs — spine (concat vs crossfade)", () => {
  it("uses xfade for crossfade joins and concat for cuts", () => {
    const filter = filterOf(buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args);
    // Sample EDL has 3 crossfade segments (idx 2,4,5) and the rest cuts.
    const crossfadeJoins = SAMPLE_EDL.segments.filter(
      (s, i) => i > 0 && s.transition === "crossfade",
    ).length;
    const cutJoins = SAMPLE_EDL.segments.length - 1 - crossfadeJoins;

    const xfadeCount = filter.split("xfade=transition=fade").length - 1;
    const concatCount = filter.split("concat=n=2:v=1:a=0").length - 1;
    expect(xfadeCount).toBe(crossfadeJoins);
    expect(concatCount).toBe(cutJoins);
    expect(filter).toContain(`duration=${CROSSFADE_S}`);
  });

  it("computes the first xfade offset as accumulated-left minus CROSSFADE_S", () => {
    const filter = filterOf(buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args);
    // Segments 0,1 are cuts; segment 2 is the first crossfade. Left length is
    // seg0 + seg1 (both cuts), offset = that - CROSSFADE_S.
    const seg0 = SAMPLE_EDL.segments[0]!.out - SAMPLE_EDL.segments[0]!.in;
    const seg1 = SAMPLE_EDL.segments[1]!.out - SAMPLE_EDL.segments[1]!.in;
    const offset = Math.round((seg0 + seg1 - CROSSFADE_S) * 1000) / 1000;
    expect(filter).toContain(`xfade=transition=fade:duration=${CROSSFADE_S}:offset=${offset}`);
  });

  it("maps the final spine label and disables audio", () => {
    const args = buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args;
    expect(args).toContain("-map");
    expect(args).toContain("[outv]");
    expect(args).toContain("-an");
  });

  it("single-segment EDL maps v0 with no concat/xfade", () => {
    const single: Edl = { ...SAMPLE_EDL, segments: [SAMPLE_EDL.segments[0]!] };
    const args = buildFfmpegArgs(single, SAMPLE_CLIPS, OUT);
    const filter = filterOf(args.args);
    expect(filter).not.toContain("concat");
    expect(filter).not.toContain("xfade");
    expect(args.args).toContain("[v0]");
  });
});

describe("buildFfmpegArgs — lut3d + encode flags", () => {
  it("omits lut3d when edl.lut is null", () => {
    const filter = filterOf(buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args);
    expect(filter).not.toContain("lut3d");
  });

  it("applies lut3d to every segment when edl.lut is set", () => {
    const graded: Edl = { ...SAMPLE_EDL, lut: "luts/teal-orange.cube" };
    const filter = filterOf(buildFfmpegArgs(graded, SAMPLE_CLIPS, OUT).args);
    const count = filter.split("lut3d=luts/teal-orange.cube").length - 1;
    expect(count).toBe(graded.segments.length);
  });

  it("always uses ultrafast preset and yuv420p, writes the output path last", () => {
    const args = buildFfmpegArgs(SAMPLE_EDL, SAMPLE_CLIPS, OUT).args;
    expect(args).toContain("-preset");
    expect(args[args.indexOf("-preset") + 1]).toBe("ultrafast");
    expect(args).toContain("-pix_fmt");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.length - 1]).toBe(OUT);
  });
});

describe("over-length detection via edlDurationS", () => {
  it("flags an EDL whose duration exceeds target + tolerance", () => {
    const over: Edl = {
      ...SAMPLE_EDL,
      targetLenS: 5, // sample timeline is ~30s → well over 5 + tolerance
    };
    const dur = edlDurationS(over);
    const overLength = dur > over.targetLenS + TARGET_LEN_TOLERANCE_S;
    expect(overLength).toBe(true);
  });

  it("does not flag the in-spec sample EDL", () => {
    const dur = edlDurationS(SAMPLE_EDL);
    const overLength = dur > SAMPLE_EDL.targetLenS + TARGET_LEN_TOLERANCE_S;
    expect(overLength).toBe(false);
  });
});
