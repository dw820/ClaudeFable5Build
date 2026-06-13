/**
 * Scene detection for the offline preprocess pipeline.
 *
 * Pixel-difference scene detection (ffmpeg `select='gt(scene,T)'`) finds hard
 * cuts; the cadence ceiling (SCENE_MAX_S) backstops soft transitions it misses,
 * the floor (MIN_SCENE_S) debounces false positives, and a per-clip budget
 * coarsens (never truncates) on degenerate input.
 *
 * Pure core (`parseSceneCuts`, `buildWindows`, `applyBudget`) is split from the
 * single ffmpeg call (`detectScenes`) so it unit-tests with no ffmpeg.
 */
import type { ExecFn } from "./frameUnderstand.js";
import { SCENE_THRESHOLD, MIN_SCENE_S, SCENE_MAX_S, SCENE_BUDGET } from "./constants.js";

/** A half-open time window `[t0, t1)` within a clip, in seconds. */
export interface SceneWindow {
  t0: number;
  t1: number;
}

/** PURE: extract sorted, de-duped `pts_time` cut timestamps from ffmpeg showinfo stderr. */
export function parseSceneCuts(stderr: string): number[] {
  const times = new Set<number>();
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) times.add(t);
  }
  return [...times].sort((a, b) => a - b);
}

export interface WindowOptions {
  minSceneS: number;
  maxSceneS: number;
}

/**
 * PURE: cuts + duration → contiguous windows covering `[0, duration]`, then
 * merge (sub-`minSceneS` windows fold into the previous, or into the next if
 * they are first) and subdivide (windows over `maxSceneS` split into equal
 * sub-windows). Defends against a non-positive duration by returning [].
 */
export function buildWindows(cuts: number[], durationS: number, opts: WindowOptions): SceneWindow[] {
  if (!(durationS > 0)) return [];

  // 1. Boundaries → raw contiguous windows.
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < durationS), durationS];
  const raw: SceneWindow[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) raw.push({ t0: bounds[i]!, t1: bounds[i + 1]! });

  // 2. Merge windows shorter than the floor.
  const merged: SceneWindow[] = [];
  for (const w of raw) {
    const prev = merged[merged.length - 1];
    if (w.t1 - w.t0 < opts.minSceneS && prev) {
      prev.t1 = w.t1; // fold into previous
    } else if (w.t1 - w.t0 < opts.minSceneS && merged.length === 0) {
      merged.push({ ...w }); // first window short: keep, next short one folds in
    } else {
      merged.push({ ...w });
    }
  }
  // A short FIRST window left over (no following window absorbed it) folds forward.
  if (merged.length >= 2 && merged[0]!.t1 - merged[0]!.t0 < opts.minSceneS) {
    merged[1]!.t0 = merged[0]!.t0;
    merged.shift();
  }

  // 3. Subdivide windows longer than the ceiling into equal sub-windows.
  const out: SceneWindow[] = [];
  for (const w of merged) {
    const len = w.t1 - w.t0;
    if (len > opts.maxSceneS) {
      const n = Math.ceil(len / opts.maxSceneS);
      const step = len / n;
      for (let i = 0; i < n; i++) {
        out.push({ t0: w.t0 + i * step, t1: i === n - 1 ? w.t1 : w.t0 + (i + 1) * step });
      }
    } else {
      out.push(w);
    }
  }
  return out;
}

/**
 * PURE: bound VLM cost without dropping coverage. If more windows than `budget`,
 * replace them with exactly `budget` equal windows spanning `[0, durationS]` —
 * the whole clip stays covered end-to-end, only granularity coarsens. This only
 * triggers on degenerate input (strobe / heavy handheld).
 */
export function applyBudget(
  windows: SceneWindow[],
  durationS: number,
  budget: number,
): { windows: SceneWindow[]; coarsened: boolean } {
  if (windows.length <= budget) return { windows, coarsened: false };
  const step = durationS / budget;
  const coarse: SceneWindow[] = [];
  for (let i = 0; i < budget; i++) {
    coarse.push({ t0: i * step, t1: i === budget - 1 ? durationS : (i + 1) * step });
  }
  return { windows: coarse, coarsened: true };
}
