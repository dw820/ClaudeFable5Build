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
