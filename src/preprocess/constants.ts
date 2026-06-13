/**
 * Local preprocess constants. Kept in-module (not in the frozen shared
 * src/constants.ts) since these are producer-side only.
 */

/** Default local media root for clip.src resolution (mirrors edit/ default). */
export const MEDIA_DIR_DEFAULT = process.env.MEDIA_DIR ?? "./media";
