/**
 * Integration tests (gated; require binaries).
 *
 *  - RUN_REMOTION=1: PRIMARY path renders captions over a testsrc base clip.
 *  - RUN_FFMPEG=1:   FALLBACK path (forced) produces a captioned file.
 *
 * Both generate their own base clip with `ffmpeg testsrc`, so they need ffmpeg.
 * Skipped by default so `npm test` stays green offline.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EdlSchema, type Edl } from "../loop/types.js";
import { applyOverlay, defaultFfmpegExec, defaultRemotionRenderer } from "./overlay.js";

const RUN_REMOTION = !!process.env.RUN_REMOTION;
const RUN_FFMPEG = !!process.env.RUN_FFMPEG;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-1000)))));
  });
}

/** Generate a short 9:16 base clip with testsrc. */
async function makeBaseClip(out: string, seconds = 5): Promise<void> {
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1080x1920:rate=30:duration=${seconds}`,
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
}

/** A tiny 2-segment EDL whose timeline fits inside the base clip. */
function tinyEdl(): Edl {
  return EdlSchema.parse({
    edlId: "edl-int",
    aspect: "9:16",
    targetLenS: 5,
    lut: null,
    segments: [
      {
        clipId: "c01",
        in: 0,
        out: 2.5,
        transition: "cut",
        captions: [{ text: "hello world", t0: 0.1, t1: 2.0, style: "bold-center" }],
      },
      {
        clipId: "c02",
        in: 0,
        out: 2.5,
        transition: "cut",
        captions: [{ text: "second line", t0: 0.0, t1: 2.0, style: "bold-bottom" }],
      },
    ],
    selectionRationale: "",
  });
}

describe("overlay integration", () => {
  it.skipIf(!RUN_REMOTION)(
    "PRIMARY: Remotion renders captions over a base clip",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "overlay-rem-"));
      const base = path.join(dir, "base.mp4");
      await makeBaseClip(base);

      const res = await applyOverlay(base, tinyEdl(), {
        renderRemotion: defaultRemotionRenderer,
        // ffmpeg fallback should not be needed; fail loudly if it is.
        runFfmpeg: async () => {
          throw new Error("fallback should not run on the primary path");
        },
        timeoutMs: 240_000,
      });

      expect(res.usedFallback).toBe(false);
      expect(existsSync(res.path)).toBe(true);
      expect(statSync(res.path).size).toBeGreaterThan(0);
    },
    300_000,
  );

  it.skipIf(!RUN_FFMPEG)(
    "FALLBACK: forced ffmpeg drawtext produces a captioned file",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "overlay-ff-"));
      const base = path.join(dir, "base.mp4");
      await makeBaseClip(base);

      const res = await applyOverlay(base, tinyEdl(), {
        // Force the fallback by making the primary path throw.
        renderRemotion: async () => {
          throw new Error("forced primary failure");
        },
        runFfmpeg: defaultFfmpegExec,
      });

      expect(res.usedFallback).toBe(true);
      expect(existsSync(res.path)).toBe(true);
      expect(statSync(res.path).size).toBeGreaterThan(0);
    },
    120_000,
  );
});
