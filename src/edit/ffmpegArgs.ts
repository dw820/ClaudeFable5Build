/**
 * Pure ffmpeg argument builder for the cut half of render (Lane A).
 *
 * Given an EDL + ClipLibrary, this emits the exact `ffmpeg` argv array and the
 * computed output WxH — with NO process/exec/filesystem side effects — so the
 * whole filtergraph (trim, scale/pad, lut3d, concat, xfade) is unit-testable
 * offline. `cut.ts` is the thin spawn wrapper around what this produces.
 *
 * Filtergraph shape (per segment i, then a concat/xfade spine):
 *
 *   [i:v] trim=start=in:end=out, setpts=PTS-STARTPTS,
 *         scale=W:H:force_original_aspect_ratio=decrease,
 *         pad=W:H:(centered), setsar=1 [, lut3d=<cube>]  ──▶ [v{i}]
 *
 *   cut spine:       [v0][v1]...  concat=n=N:v=1:a=0  ──▶ [outv]
 *   crossfade spine: xfade=transition=fade:duration=CROSSFADE_S:offset=<acc>
 *                    chained pairwise, offsets accounting for overlap.
 *
 * A segment's `transition` describes how it joins the segment BEFORE it, matching
 * `edlDurationS` (which subtracts CROSSFADE_S when segment i>0 is "crossfade").
 */
import { join } from "node:path";
import { CROSSFADE_S } from "../constants.js";
import type { ClipLibrary, Edl } from "../loop/types.js";

/** Resolve the media root the same way across cut + tests. */
export const mediaDir = (): string => process.env.MEDIA_DIR ?? "./media";

/** Output pixel dimensions per aspect (PRD: vertical-first, 1080-class). */
export const ASPECT_DIMENSIONS = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
} as const satisfies Record<Edl["aspect"], { w: number; h: number }>;

export interface FfmpegPlan {
  /** Full argv for `ffmpeg` (no leading "ffmpeg"). */
  args: string[];
  /** Computed output dimensions for the chosen aspect. */
  width: number;
  height: number;
  /** Absolute-ish input paths, in segment order (clip.src resolved vs MEDIA_DIR). */
  inputs: string[];
}

/** Look up a clip by id or throw — a dangling clipId is a build error, not silent. */
function clipSrc(clips: ClipLibrary, clipId: string): string {
  const clip = clips.clips.find((c) => c.id === clipId);
  if (clip === undefined) {
    throw new Error(`EDL references unknown clipId "${clipId}"`);
  }
  return clip.src;
}

/**
 * Build the ffmpeg argv + output geometry for an EDL. Pure: no exec, no fs.
 *
 * @param outputPath where the spawn wrapper will write the mp4 (last argv token)
 */
export function buildFfmpegArgs(
  edl: Edl,
  clips: ClipLibrary,
  outputPath: string,
): FfmpegPlan {
  const { w, h } = ASPECT_DIMENSIONS[edl.aspect];
  const root = mediaDir();

  // One -i per segment (segments may reuse the same clip; each gets its own
  // input + trim so PTS resets independently and reuse stays correct).
  const inputs = edl.segments.map((seg) => join(root, clipSrc(clips, seg.clipId)));

  const lut = edl.lut;
  const filterParts: string[] = [];

  // Per-segment normalize chain → [v{i}].
  edl.segments.forEach((seg, i) => {
    const steps = [
      `trim=start=${seg.in}:end=${seg.out}`,
      "setpts=PTS-STARTPTS",
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
    ];
    if (lut !== null && lut !== undefined && lut !== "") {
      steps.push(`lut3d=${lut}`);
    }
    filterParts.push(`[${i}:v]${steps.join(",")}[v${i}]`);
  });

  // Spine: chain segments. xfade when the JOINING segment is "crossfade",
  // otherwise concat. We fold pairwise so a mix of cut/crossfade composes.
  const n = edl.segments.length;
  let outLabel: string;

  if (n === 1) {
    outLabel = "v0";
  } else {
    // Track the running duration of the accumulated left side so xfade offset
    // (where the fade starts) is left_len - CROSSFADE_S.
    let leftLen = segLen(edl, 0);
    let prevLabel = "v0";
    for (let i = 1; i < n; i++) {
      const segDur = segLen(edl, i);
      const cur = `v${i}`;
      const next = i === n - 1 ? "outv" : `m${i}`;
      if (edl.segments[i]!.transition === "crossfade") {
        const offset = round3(Math.max(0, leftLen - CROSSFADE_S));
        filterParts.push(
          `[${prevLabel}][${cur}]xfade=transition=fade:duration=${CROSSFADE_S}:offset=${offset}[${next}]`,
        );
        leftLen = round3(leftLen + segDur - CROSSFADE_S);
      } else {
        filterParts.push(`[${prevLabel}][${cur}]concat=n=2:v=1:a=0[${next}]`);
        leftLen = round3(leftLen + segDur);
      }
      prevLabel = next;
    }
    outLabel = "outv";
  }

  const filterComplex = filterParts.join(";");

  const args: string[] = [];
  for (const input of inputs) {
    args.push("-i", input);
  }
  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    `[${outLabel}]`,
    "-an",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-y",
    outputPath,
  );

  return { args, width: w, height: h, inputs };
}

/** Length of segment i on the timeline (out - in), clamped at 0. */
function segLen(edl: Edl, i: number): number {
  const seg = edl.segments[i]!;
  return Math.max(0, seg.out - seg.in);
}

/** Keep filtergraph offsets readable + stable (avoids float noise in argv). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
