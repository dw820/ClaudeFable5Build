/**
 * cutVideo — the "cut" half of render (Lane A).
 *
 * Pipeline:
 *
 *   EDL + ClipLibrary
 *        │
 *        ▼
 *   buildFfmpegArgs (pure)         resolve clip.src vs MEDIA_DIR,
 *        │                         per-seg trim → scale/pad → [lut3d],
 *        │                         concat / xfade spine, ultrafast/yuv420p
 *        ▼
 *   spawn("ffmpeg", args)  ──▶  <outDir>/<edlId>.mp4
 *        │
 *        ▼
 *   { path, durationS: edlDurationS(edl) }
 *
 * The returned durationS is the EDL's deterministic timeline length (shared
 * helper), NOT a probe of the file — the renderer and builder must agree on
 * length math, and ffprobe noise would break that contract.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edlDurationS } from "../constants.js";
import type { ClipLibrary, Edl } from "../loop/types.js";
import { buildFfmpegArgs } from "./ffmpegArgs.js";

export interface CutOptions {
  /** Directory to write the cut mp4 into. Defaults to os.tmpdir(). */
  outDir?: string;
  /** ffmpeg binary name/path. Defaults to "ffmpeg" (PATH lookup). */
  ffmpegBin?: string;
}

/**
 * Compile an EDL into a single normalized mp4 (no captions/overlay yet).
 * Resolves clip sources against MEDIA_DIR, runs ffmpeg, and returns the output
 * path plus the EDL's deterministic duration.
 */
export async function cutVideo(
  edl: Edl,
  clips: ClipLibrary,
  options: CutOptions = {},
): Promise<{ path: string; durationS: number }> {
  const outDir = options.outDir ?? tmpdir();
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const outputPath = join(outDir, `${edl.edlId}.mp4`);

  const { args } = buildFfmpegArgs(edl, clips, outputPath);

  await runFfmpeg(ffmpegBin, args);

  return { path: outputPath, durationS: edlDurationS(edl) };
}

/** Run ffmpeg to completion; reject with stderr tail on a non-zero exit. */
function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", (err) => {
      reject(new Error(`failed to spawn ffmpeg ("${bin}"): ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr.trim()}`));
      }
    });
  });
}
