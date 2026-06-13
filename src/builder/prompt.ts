/**
 * Pure prompt builder for the EDL builder (Lane D).
 *
 * No I/O, no LlmClient, no side effects: given a `BuildContext` it returns the
 * exact `{ system, user }` strings the model is asked to complete. Keeping this
 * pure means a unit test can assert the prompt carries the clip ids, the rubric
 * dimensions, and — on a self-correction iteration — the previous feedback,
 * without standing up a client or hitting the network.
 *
 * On ctx.iteration > 1 the user prompt additionally carries the previous grade's
 * per-dimension feedback and a compact summary of the previous EDL, instructing
 * the model to FIX the flagged dimensions rather than rebuild from scratch.
 */
import { RUBRIC_DIMENSIONS, type Clip, type Edl } from "../loop/types.js";
import type { BuildContext } from "../loop/controller.js";
import { TARGET_LEN_TOLERANCE_S } from "../constants.js";

/** Target output length + aspect the builder asks the model to hit. */
export const DEFAULT_TARGET_LEN_S = 20;
export const DEFAULT_ASPECT: Edl["aspect"] = "9:16";

const SYSTEM_PROMPT = [
  "You are an expert short-form video editor who assembles viral vertical clips",
  "(TikTok / Reels / Shorts). You are given a library of source clips and a brief,",
  "and you cut them into an Edit Decision List (EDL).",
  "",
  "Editing principles:",
  "- Lead with the strongest hook in the first 2 seconds — peak moment up front.",
  "- Keep cuts tight and energetic; no dragging middle.",
  "- Add large, high-contrast on-screen captions timed to the action.",
  "- Make the ending flow back into the opening so the clip loops on replay.",
  "- Only reference clip ids that exist in the provided library.",
  "",
  "Respond with ONLY a single JSON object matching the requested schema — no prose,",
  "no markdown fences, no commentary.",
].join("\n");

/** One transcript line, trimmed to a short snippet so the prompt stays compact. */
function transcriptSnippet(clip: Clip, maxWords = 12): string {
  if (clip.transcript.length === 0) return "(no speech)";
  const words = clip.transcript.slice(0, maxWords).map((w) => w.word);
  const suffix = clip.transcript.length > maxWords ? " …" : "";
  return words.join(" ") + suffix;
}

/** Render one clip as a compact, model-readable line. */
function describeClip(clip: Clip): string {
  return [
    `- id=${clip.id}`,
    `duration=${clip.duration}s`,
    `tags=[${clip.tags.join(", ")}]`,
    `caption="${clip.caption}"`,
    `transcript="${transcriptSnippet(clip)}"`,
  ].join(" | ");
}

/** The rubric dimensions block, keyed by the canonical RUBRIC_DIMENSIONS. */
function describeRubric(rubricStyle: string): string {
  const lines = RUBRIC_DIMENSIONS.map((d) => `- ${d}`);
  return [`Optimize for the "${rubricStyle}" rubric. Dimensions graded:`, ...lines].join("\n");
}

/**
 * Self-correction block for iteration > 1: the previous EDL summary plus the
 * per-dimension feedback the verifier emitted. Feedback keys are RUBRIC_DIMENSIONS
 * values (plus reserved keys like `_general`), matching what the verifier writes.
 */
function describeSelfCorrection(ctx: BuildContext): string {
  const parts: string[] = [
    "",
    "This is a REVISION. The previous attempt did not pass. Fix the flagged",
    "dimensions below while keeping what already worked.",
  ];

  if (ctx.previousEdl) {
    const segs = ctx.previousEdl.segments
      .map((s) => `${s.clipId}(${s.in}-${s.out}s, ${s.transition})`)
      .join(" → ");
    parts.push("", "Previous EDL segments:", segs);
  }

  const feedback = ctx.previousFeedback ?? {};
  const entries = Object.entries(feedback);
  if (entries.length > 0) {
    parts.push("", "Feedback to address (keyed by rubric dimension):");
    for (const [dimension, note] of entries) {
      parts.push(`- ${dimension}: ${note}`);
    }
  }

  return parts.join("\n");
}

/**
 * The EDL schema description the model must match. Mirrors EdlSchema in
 * loop/types.ts; intentionally hand-written prose so we don't depend on zod's
 * internal shape.
 */
function describeSchema(targetLenS: number, aspect: Edl["aspect"]): string {
  return [
    "Return JSON with this shape:",
    "{",
    '  "edlId": string,',
    `  "aspect": "${aspect}",`,
    `  "targetLenS": ${targetLenS},`,
    '  "lut": string | null,',
    '  "segments": [',
    "    {",
    '      "clipId": string (must exist in the library),',
    '      "in": number (seconds, >= 0),',
    '      "out": number (seconds, > in, <= clip duration),',
    '      "transition": "cut" | "crossfade",',
    '      "captions": [',
    '        { "text": string, "t0": number, "t1": number, "style": string }',
    "      ]",
    "    }",
    "  ],",
    '  "selectionRationale": string',
    "}",
    "",
    `The summed segment durations should total about ${targetLenS}s`,
    `(within ${TARGET_LEN_TOLERANCE_S}s).`,
  ].join("\n");
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Surfaced so build.ts can post-filter/nudge toward the same target. */
  targetLenS: number;
  aspect: Edl["aspect"];
}

/**
 * Build the `{ system, user }` prompt for a given BuildContext. Pure.
 */
export function buildPrompt(ctx: BuildContext): BuiltPrompt {
  const targetLenS = DEFAULT_TARGET_LEN_S;
  const aspect = DEFAULT_ASPECT;

  const clipLines = ctx.library.clips.map(describeClip).join("\n");

  const userParts: string[] = [
    `Brief: ${ctx.brief}`,
    "",
    describeRubric(ctx.rubric.style),
    "",
    `Target length: ${targetLenS}s. Aspect ratio: ${aspect}.`,
    "",
    `Clip library (${ctx.library.clips.length} clips):`,
    clipLines,
  ];

  if (ctx.iteration > 1) {
    userParts.push(describeSelfCorrection(ctx));
  }

  userParts.push("", describeSchema(targetLenS, aspect));

  return {
    system: SYSTEM_PROMPT,
    user: userParts.join("\n"),
    targetLenS,
    aspect,
  };
}
