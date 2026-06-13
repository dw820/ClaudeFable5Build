/**
 * Pure Edl → Remotion inputProps mapping.
 *
 * The EDL stores each caption's `t0`/`t1` RELATIVE to its own segment's start.
 * The overlay renders captions onto the already-concatenated base video, whose
 * timeline is the sum of segment lengths minus crossfade overlaps (the same math
 * `edlDurationS` uses). So each segment has an absolute start offset, and a
 * caption's absolute window is `segmentStart + t0 .. segmentStart + t1`.
 *
 *   seg0 |----|                      start = 0
 *   seg1      |----|   cut           start = len(seg0)
 *   seg2        \--|----|  crossfade  start = prev - CROSSFADE_S  (overlap)
 *
 * Output is a plain JSON-serializable object (Remotion serializes inputProps),
 * so this file is fully unit-testable with no Remotion import.
 */
import { CROSSFADE_S } from "../constants.js";
import type { Edl } from "../loop/types.js";

/** A single caption with absolute timings (seconds) on the concatenated video. */
export interface AbsoluteCaption {
  text: string;
  /** Absolute start on the base-video timeline, seconds. */
  startS: number;
  /** Absolute end on the base-video timeline, seconds. */
  endS: number;
  /** Style token (e.g. "bold-center"); the composition maps it to visuals. */
  style: string;
}

/** inputProps handed to the Remotion Captions composition. */
export interface CaptionInputProps {
  /** Absolute filesystem path to the base (cut) video to overlay onto. */
  basePath: string;
  /** Total timeline length in seconds (drives composition duration). */
  durationS: number;
  /** Caption track with absolute timings, in document order. */
  captions: AbsoluteCaption[];
  /** Aspect ratio of the cut, so the composition can size itself. */
  aspect: Edl["aspect"];
  [key: string]: unknown;
}

/** Pixel dimensions for each supported aspect ratio (9:16 vertical default). */
export const ASPECT_DIMENSIONS: Record<Edl["aspect"], { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
};

/** Length of one segment on the cut timeline, seconds (never negative). */
function segmentLenS(inS: number, outS: number): number {
  return Math.max(0, outS - inS);
}

/**
 * Map an Edl to Remotion inputProps with captions promoted to absolute timings.
 * Mirrors `edlDurationS`: crossfade segments overlap the previous by CROSSFADE_S,
 * so a crossfaded segment's start is pulled back by the same amount.
 */
export function edlToCaptionProps(basePath: string, edl: Edl): CaptionInputProps {
  const captions: AbsoluteCaption[] = [];
  let cursorS = 0;

  edl.segments.forEach((seg, i) => {
    const start = i > 0 && seg.transition === "crossfade" ? cursorS - CROSSFADE_S : cursorS;
    for (const cap of seg.captions) {
      captions.push({
        text: cap.text,
        startS: start + cap.t0,
        endS: start + cap.t1,
        style: cap.style,
      });
    }
    cursorS = start + segmentLenS(seg.in, seg.out);
  });

  return {
    basePath,
    durationS: Math.max(0, cursorS),
    captions,
    aspect: edl.aspect,
  };
}
