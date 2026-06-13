/**
 * Pure builder of the director-verifier vision prompt (Lane C).
 *
 * INDEPENDENCE IS THE POINT. The verifier sees only (a) the rubric dimensions
 * and (b) the rendered keyframes. It receives NO EDL, no segment list, no clipId,
 * no builder rationale — captions are burned into the pixels, so the director
 * judges what a viewer would actually see. This builder takes only a rubric +
 * frames; there is no parameter through which builder state could leak in.
 *
 *   rubric dimensions ─┐
 *                      ├─▶ { system, user, images }  (no EDL anywhere)
 *   keyframes ─────────┘
 */
import { RUBRIC_DIMENSIONS } from "../loop/types.js";
import { RESERVED_FEEDBACK_KEYS } from "../constants.js";
import type { LlmImage, LlmCompleteOptions } from "../llm/client.js";
import type { Rubric } from "../loop/controller.js";
import type { LoadedRubric } from "./rubric.js";

const SYSTEM_PROMPT =
  "You are a Viral Short director — a ruthless judge of vertical short-form video. " +
  "You are shown only still keyframes from a finished, rendered clip (captions are " +
  "already burned into the pixels). You did NOT plan or build this cut and you have " +
  "no access to its edit decisions — judge solely what a phone viewer would see. " +
  "Score honestly; a weak, slow, or unreadable clip should score low.";

/** True when the rubric carries per-dimension prose (a LoadedRubric). */
function hasDimensionProse(r: Rubric | LoadedRubric): r is LoadedRubric {
  return typeof (r as LoadedRubric).dimensions === "object" && (r as LoadedRubric).dimensions !== null;
}

/** One rubric line per dimension: `name — prose` when prose is available. */
function rubricLines(rubric: Rubric | LoadedRubric): string {
  const prose = hasDimensionProse(rubric) ? rubric.dimensions : undefined;
  return RUBRIC_DIMENSIONS.map((d) =>
    prose?.[d] ? `- ${d}: ${prose[d]}` : `- ${d}`,
  ).join("\n");
}

/**
 * Build the system/user/images payload for `llm.complete`.
 *
 * The user text instructs a strict JSON shape matching GradeSchema: a `scores`
 * object with every dimension scored 0–10, and a `feedback` map keyed by
 * dimension (plus the reserved keys the rest of the system understands).
 */
export function buildVerifierPrompt(
  rubric: Rubric | LoadedRubric,
  frames: LlmImage[],
): LlmCompleteOptions {
  const dims = RUBRIC_DIMENSIONS.join(", ");
  const reserved = RESERVED_FEEDBACK_KEYS.join(", ");

  const user =
    `Style being graded: ${rubric.style}\n\n` +
    `You are shown ${frames.length} keyframe(s) sampled evenly across the clip, in order.\n\n` +
    `Score each rubric dimension from 0 (terrible) to 10 (excellent):\n` +
    `${rubricLines(rubric)}\n\n` +
    `Return ONLY a JSON object, no prose, in exactly this shape:\n` +
    `{\n` +
    `  "scores": { ${RUBRIC_DIMENSIONS.map((d) => `"${d}": <0-10>`).join(", ")} },\n` +
    `  "feedback": { "<dimension>": "<one concrete, actionable fix>" }\n` +
    `}\n\n` +
    `Rules:\n` +
    `- "scores" MUST contain every dimension: ${dims}.\n` +
    `- "feedback" keys MUST be one of those dimensions${
      RESERVED_FEEDBACK_KEYS.length ? ` or a reserved key (${reserved})` : ""
    }; include feedback for any dimension you scored below ${rubric.passThreshold}.\n` +
    `- Do not include any field other than "scores" and "feedback".`;

  return { system: SYSTEM_PROMPT, user, images: frames };
}
