/**
 * Shared constants + helpers used across lanes. Frozen in the pre-step so no two
 * modules invent their own tolerance/duration math (the cross-module drift the
 * eng review flagged).
 */
import type { Edl } from "./loop/types.js";

/** Output duration may differ from targetLenS by at most this (seconds). */
export const TARGET_LEN_TOLERANCE_S = 1.5;

/** Crossfade transitions overlap adjacent segments by this much (seconds). */
export const CROSSFADE_S = 0.4;

/** Keyframes the verifier extracts per render for vision grading. */
export const KEYFRAME_COUNT = 5;

/** A rubric dimension passes when its score is >= this. */
export const PASS_THRESHOLD = 7;

/**
 * Feedback keys are rubric-dimension names; these reserved keys carry
 * non-dimension signals. Builder (Lane D) and verifier (Lane C) must agree.
 *   _edl       — the previous EDL was structurally invalid (written by controller)
 *   _general   — overall note not tied to one dimension
 *   _verifier  — verifier was unavailable; the grade is a sentinel failure
 */
export const RESERVED_FEEDBACK_KEYS = ["_edl", "_general", "_verifier"] as const;
export type ReservedFeedbackKey = (typeof RESERVED_FEEDBACK_KEYS)[number];

/**
 * Total rendered duration of an EDL, accounting for crossfade overlaps.
 * Both the renderer (Lane A concat) and the builder (Lane D length nudge) MUST
 * use this so their length numbers agree.
 *
 *   seg0 [----]                 sum of (out-in)
 *   seg1      [----]   cut      no overlap
 *   seg2        \--[----]  xfade  minus CROSSFADE_S
 */
export function edlDurationS(edl: Edl): number {
  let total = 0;
  edl.segments.forEach((seg, i) => {
    total += Math.max(0, seg.out - seg.in);
    if (i > 0 && seg.transition === "crossfade") total -= CROSSFADE_S;
  });
  return Math.max(0, total);
}

/** True when an EDL's duration is within tolerance of its target. */
export function withinTargetLen(edl: Edl): boolean {
  return Math.abs(edlDurationS(edl) - edl.targetLenS) <= TARGET_LEN_TOLERANCE_S;
}
