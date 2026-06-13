/**
 * Keyframe extraction for the director verifier (Lane C).
 *
 * The verifier grades a render from a handful of evenly-spaced still frames, not
 * the video file — vision input is images. ffmpeg is the extraction tool, but it
 * is *injected* (an `ExecFn`) so unit tests never shell out: a fake exec returns
 * canned base64 and the whole grade path runs with no ffmpeg, no API key.
 *
 *   render.output ──▶ ffprobe duration ──▶ N evenly-spaced timestamps
 *                       (injected exec)         │
 *                                               ▼
 *                              ffmpeg -ss t -frames:v 1 → jpeg → base64
 *                                               │
 *                                               ▼
 *                                        LlmImage[] (length N)
 */
import { KEYFRAME_COUNT } from "../constants.js";
import type { LlmImage } from "../llm/client.js";

/**
 * Runs a command and resolves its raw stdout bytes. Production wires this to
 * `child_process` / ffmpeg; tests pass a fake. Kept deliberately small so the
 * seam is trivial to stub.
 */
export type ExecFn = (cmd: string, args: string[]) => Promise<Buffer>;

export interface FrameExtractOptions {
  /** How many frames to pull. Defaults to KEYFRAME_COUNT (shared constant). */
  count?: number;
  /** ffmpeg binary name/path. */
  ffmpegBin?: string;
  /** ffprobe binary name/path. */
  ffprobeBin?: string;
  /** Total media duration (seconds). When omitted, probed via ffprobe. */
  durationS?: number;
}

/** Parse a duration (seconds, float) from ffprobe stdout; NaN-safe. */
function parseDuration(stdout: Buffer): number {
  const n = Number.parseFloat(stdout.toString("utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Evenly-spaced sample timestamps across `durationS`, biased away from the exact
 * endpoints (a frame at t=duration often fails to decode). For duration 0 we
 * still return `count` timestamps at 0 so callers get a stable-length result.
 */
function sampleTimestamps(durationS: number, count: number): number[] {
  if (count <= 0) return [];
  if (durationS <= 0) return Array.from({ length: count }, () => 0);
  // Place samples at the midpoints of `count` equal buckets: (i+0.5)/count.
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * durationS);
}

/**
 * Extract `count` keyframes from a rendered video as base64 JPEGs.
 *
 * Injectable via `exec` so unit tests run without ffmpeg. The returned array is
 * always length `count` (the verifier prompt builder relies on a stable frame
 * count); a frame that fails to decode is skipped only if exec rejects, in which
 * case the error propagates to the caller (grade.ts treats extraction failure as
 * an unrecoverable → sentinel grade).
 */
export async function extractKeyframes(
  output: string,
  exec: ExecFn,
  opts: FrameExtractOptions = {},
): Promise<LlmImage[]> {
  const count = opts.count ?? KEYFRAME_COUNT;
  const ffmpeg = opts.ffmpegBin ?? "ffmpeg";
  const ffprobe = opts.ffprobeBin ?? "ffprobe";

  let durationS = opts.durationS;
  if (durationS === undefined) {
    const probe = await exec(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      output,
    ]);
    durationS = parseDuration(probe);
  }

  const timestamps = sampleTimestamps(durationS, count);
  const frames: LlmImage[] = [];
  for (const t of timestamps) {
    // `-ss` before `-i` seeks fast; one frame, jpeg, to stdout (pipe:1).
    const bytes = await exec(ffmpeg, [
      "-v",
      "error",
      "-ss",
      t.toFixed(3),
      "-i",
      output,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ]);
    frames.push({ mediaType: "image/jpeg", dataBase64: bytes.toString("base64") });
  }
  return frames;
}
