/**
 * Pure ffmpeg `drawtext` filter builder — the fallback caption path.
 *
 * When the Remotion render fails or times out, we burn captions with ffmpeg
 * instead. Each caption becomes one `drawtext` filter gated by
 * `enable='between(t,t0,t1)'` so it shows only inside its absolute window.
 * Timings come from the same `edlToCaptionProps` mapping the Remotion path uses,
 * so primary and fallback agree to the millisecond.
 *
 * This module is pure (no exec, no fs): it returns argv + filter strings that
 * `overlay.ts` hands to an injected ffmpeg runner, which keeps it unit-testable.
 */
import { edlToCaptionProps } from "./captionProps.js";
import type { Edl } from "../loop/types.js";

/** Per-style drawtext appearance. Mirrors the Remotion template's intent. */
interface StyleSpec {
  fontsize: number;
  fontcolor: string;
  /** ffmpeg x/y expressions (use text_w/text_h/w/h). */
  x: string;
  y: string;
  box: boolean;
  boxcolor: string;
  boxborderw: number;
}

const DEFAULT_STYLE: StyleSpec = {
  fontsize: 64,
  fontcolor: "white",
  x: "(w-text_w)/2",
  y: "(h-text_h)/2",
  box: true,
  boxcolor: "black@0.5",
  boxborderw: 24,
};

/** Style table; unknown styles fall back to bold-center defaults. */
const STYLES: Record<string, StyleSpec> = {
  "bold-center": DEFAULT_STYLE,
  "bold-bottom": { ...DEFAULT_STYLE, y: "h-text_h-120" },
  "bold-top": { ...DEFAULT_STYLE, y: "120" },
};

/** Escape a string for use inside a single drawtext `text='...'` value. */
export function escapeDrawtext(text: string): string {
  // ffmpeg has TWO escaping levels and quotes don't fully protect the graph
  // level — a stray "," or "[" splits the filtergraph (the real bug: a caption
  // like "3, 2, 1" made ffmpeg report `No such filter: '2'`). Structural chars
  // (\ , ; [ ] = and newlines) can't be reliably escaped inside text='...', so
  // neutralize them to spaces — harmless for short captions. Then handle the
  // option-level chars: ' becomes a curly apostrophe (no escaping needed), and
  // : / % stay literal via backslash.
  return text
    .replace(/[\r\n\\,;[\]=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

/** Format a seconds value compactly (no trailing zeros) for `between(...)`. */
function fmtSeconds(s: number): string {
  return Number(s.toFixed(3)).toString();
}

/** Build a single `drawtext=...` filter for one caption. */
export function drawtextFilter(
  text: string,
  startS: number,
  endS: number,
  style: string,
): string {
  const spec = STYLES[style] ?? DEFAULT_STYLE;
  const parts = [
    `text='${escapeDrawtext(text)}'`,
    `fontsize=${spec.fontsize}`,
    `fontcolor=${spec.fontcolor}`,
    `x=${spec.x}`,
    `y=${spec.y}`,
  ];
  if (spec.box) {
    parts.push("box=1", `boxcolor=${spec.boxcolor}`, `boxborderw=${spec.boxborderw}`);
  }
  parts.push(`enable='between(t,${fmtSeconds(startS)},${fmtSeconds(endS)})'`);
  return `drawtext=${parts.join(":")}`;
}

/**
 * Build the full `-vf` filtergraph (comma-chained drawtext filters) for an EDL.
 * Returns an empty string when the EDL has no captions.
 */
export function buildDrawtextFiltergraph(edl: Edl): string {
  const { captions } = edlToCaptionProps("", edl);
  return captions
    .map((c) => drawtextFilter(c.text, c.startS, c.endS, c.style))
    .join(",");
}

/**
 * Build full ffmpeg argv to burn the EDL's captions onto `basePath` → `outPath`.
 * If there are no captions, copies the stream through (still produces a file).
 */
export function buildFfmpegCaptionArgs(basePath: string, outPath: string, edl: Edl): string[] {
  const filtergraph = buildDrawtextFiltergraph(edl);
  if (filtergraph === "") {
    return ["-y", "-i", basePath, "-c", "copy", outPath];
  }
  return [
    "-y",
    "-i",
    basePath,
    "-vf",
    filtergraph,
    "-c:a",
    "copy",
    "-preset",
    "ultrafast",
    // Cap x264 threads: the drawtext re-encode hits the same 1 GiB cgroup /
    // 48-core thread-explosion SIGKILL as the cut pass (see ffmpegArgs).
    "-threads",
    process.env.FFMPEG_THREADS ?? "4",
    outPath,
  ];
}
