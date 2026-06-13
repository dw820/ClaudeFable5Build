/**
 * Local preprocess constants. Kept in-module (not in the frozen shared
 * src/constants.ts) since these are producer-side only.
 */

/** Default local media root for clip.src resolution (mirrors edit/ default). */
export const MEDIA_DIR_DEFAULT = process.env.MEDIA_DIR ?? "./media";

/** ffmpeg `scene` score above which a frame is treated as a cut (0..1). */
export const SCENE_THRESHOLD = Number(process.env.SCENE_THRESHOLD ?? 0.4);

/** Cuts closer than this (seconds) merge — granularity floor / debounce. */
export const MIN_SCENE_S = Number(process.env.MIN_SCENE_S ?? 2);

/** Windows longer than this (seconds) are subdivided — long-take backstop. */
export const SCENE_MAX_S = Number(process.env.SCENE_MAX_S ?? 15);

/** Max VLM calls per clip before coverage coarsens (never truncates). */
export const SCENE_BUDGET = Number(process.env.SCENE_BUDGET ?? 60);
