/**
 * Replicate model identifiers used by the preprocess pipeline.
 *
 * Pinned here (one place) so the request-construction unit tests and the
 * integration run reference the same versions. Override via env for the demo
 * without touching code.
 */

/** Whisper word-level transcription (timestamped). */
export const WHISPER_MODEL =
  (process.env.REPLICATE_WHISPER_MODEL as `${string}/${string}` | undefined) ??
  "openai/whisper:8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e";

/** Vision-language model for frame caption + tag extraction. */
export const VLM_MODEL =
  (process.env.REPLICATE_VLM_MODEL as `${string}/${string}` | undefined) ??
  "yorickvp/llava-13b:80537f9eead1a5bfa72d5ac6ea6414379be41d4d4f6679fd776e9535d1eb58bb";

/** Text/image embedding model (off the demo path, but wired). */
export const EMBED_MODEL =
  (process.env.REPLICATE_EMBED_MODEL as `${string}/${string}` | undefined) ??
  "replicate/all-mpnet-base-v2:b6b7585c9640cd7a9572c6e129c9549d79c9c31f0d3fdce7baac7c67ca38f305";
