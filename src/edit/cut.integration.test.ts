/**
 * Integration test for cutVideo — actually shells out to ffmpeg/ffprobe.
 *
 * Gated on RUN_FFMPEG so the default offline suite stays green without a
 * binary. Self-generates two tiny `testsrc` clips, points a small EDL at them,
 * runs the real cut, and asserts the output exists, has ~the EDL duration, and
 * matches the aspect resolution.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClipLibrarySchema, EdlSchema, type ClipLibrary, type Edl } from "../loop/types.js";
import { edlDurationS, TARGET_LEN_TOLERANCE_S } from "../constants.js";
import { ASPECT_DIMENSIONS } from "./ffmpegArgs.js";
import { cutVideo } from "./cut.js";

const RUN = !!process.env.RUN_FFMPEG;

let workDir: string;
let mediaRoot: string;
let prevMediaDir: string | undefined;

const ASPECT: Edl["aspect"] = "9:16";

const CLIPS: ClipLibrary = ClipLibrarySchema.parse({
  projectId: "integration",
  clips: [
    {
      id: "a",
      src: "a.mp4",
      start: 0,
      end: 4,
      duration: 4,
      resolution: [1080, 1920],
      transcript: [],
      caption: "clip a",
      tags: [],
    },
    {
      id: "b",
      src: "b.mp4",
      start: 0,
      end: 4,
      duration: 4,
      resolution: [1080, 1920],
      transcript: [],
      caption: "clip b",
      tags: [],
    },
  ],
});

const EDL: Edl = EdlSchema.parse({
  edlId: "edl-integration",
  aspect: ASPECT,
  targetLenS: 6, // seg a (3s) + seg b (3s, crossfade -0.4) ≈ 5.6s
  lut: null,
  segments: [
    { clipId: "a", in: 0, out: 3, transition: "cut", captions: [] },
    { clipId: "b", in: 0, out: 3, transition: "crossfade", captions: [] },
  ],
  selectionRationale: "",
});

function gen(path: string): void {
  const { w, h } = ASPECT_DIMENSIONS[ASPECT];
  const res = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${w}x${h}:rate=30:duration=4`,
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { stdio: "ignore" },
  );
  if (res.status !== 0) throw new Error(`ffmpeg testsrc gen failed for ${path}`);
}

function probeDuration(path: string): number {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  );
  return Number.parseFloat(res.stdout.trim());
}

function probeResolution(path: string): { w: number; h: number } {
  const res = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=x:p=0",
      path,
    ],
    { encoding: "utf8" },
  );
  const [w, h] = res.stdout.trim().split("x").map(Number);
  return { w: w!, h: h! };
}

beforeAll(() => {
  if (!RUN) return;
  workDir = mkdtempSync(join(tmpdir(), "autocut-cut-"));
  mediaRoot = workDir;
  prevMediaDir = process.env.MEDIA_DIR;
  process.env.MEDIA_DIR = mediaRoot;
  gen(join(mediaRoot, "a.mp4"));
  gen(join(mediaRoot, "b.mp4"));
});

afterAll(() => {
  if (!RUN) return;
  if (prevMediaDir === undefined) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = prevMediaDir;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("cutVideo (ffmpeg integration)", () => {
  it.skipIf(!RUN)("renders a playable mp4 at target length + aspect resolution", async () => {
    const { path, durationS } = await cutVideo(EDL, CLIPS, { outDir: workDir });

    expect(existsSync(path)).toBe(true);
    expect(durationS).toBeCloseTo(edlDurationS(EDL), 5);

    const actual = probeDuration(path);
    expect(Math.abs(actual - EDL.targetLenS)).toBeLessThanOrEqual(TARGET_LEN_TOLERANCE_S);

    const { w, h } = probeResolution(path);
    expect({ w, h }).toEqual(ASPECT_DIMENSIONS[ASPECT]);
  });
});
