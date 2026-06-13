/**
 * makeGrade — the independent director verifier (Lane C).
 *
 * Returns a function matching the frozen `LoopDeps.grade` signature, so deps.ts
 * can inject the real `LlmClient`. The verifier extracts keyframes from the
 * render, asks a fresh "Viral Short director" to score them against the rubric,
 * validates the JSON, reprompts ONCE on malformed output, and falls back to a
 * sentinel FAILING grade if the LLM/extraction is unrecoverable — so the loop
 * controller always gets a well-formed Grade and can terminate on its caps.
 *
 *   render.output ─▶ extractKeyframes ─▶ buildVerifierPrompt ─▶ llm.complete
 *        (ffmpeg, injected)                  (rubric + frames,        │
 *                                             NO EDL)                 ▼
 *                                                            GradeSchema.safeParse
 *                                                              │ ok      │ malformed
 *                                                              ▼         ▼
 *                                                        clamp 0–10   reprompt ONCE
 *                                                              │         │ still bad
 *                                                              ▼         ▼
 *                                                            Grade   sentinel (all 0,
 *                                                                    _verifier:"unavailable")
 *
 *   Any throw (ffmpeg/exec/LLM) is caught → sentinel. Independence: the prompt is
 *   built from rubric + frames only; this file never receives an EDL.
 */
import { GradeSchema, RUBRIC_DIMENSIONS, type Grade, type RenderResult } from "../loop/types.js";
import type { LlmClient } from "../llm/client.js";
import type { Rubric } from "../loop/controller.js";
import { extractKeyframes, type ExecFn, type FrameExtractOptions } from "./frames.js";
import { buildVerifierPrompt } from "./prompt.js";
import type { LoadedRubric } from "./rubric.js";

/** Clamp helper — defends against a model returning 11 or -3 despite instructions. */
const clamp = (n: number): number => Math.max(0, Math.min(10, n));

/** Max output tokens for the grade call (a small JSON object). */
const GRADE_MAX_TOKENS = 1024;

export interface MakeGradeOptions {
  /** Injected command runner for keyframe extraction. Real ffmpeg in prod. */
  exec: ExecFn;
  /** Per-dimension prose to enrich the prompt (defaults to bare dimension names). */
  rubric?: LoadedRubric;
  /** Frame extraction overrides (count, binaries, known duration). */
  frameOptions?: FrameExtractOptions;
}

/**
 * Pull the first balanced JSON object out of a model response. Models sometimes
 * wrap JSON in prose or markdown fences despite instructions; this finds the
 * outermost `{...}` so safeParse has a real object to chew on.
 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Sentinel failing grade — all dimensions 0, tagged so the loop knows why. */
function sentinelGrade(renderId: string): Grade {
  const scores = Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, 0])) as Grade["scores"];
  return { renderId, scores, feedback: { _verifier: "unavailable" } };
}

/**
 * Parse + clamp a raw model response into a Grade. Returns null when the response
 * does not validate, so the caller can decide to reprompt or fall back.
 */
function tryParseGrade(text: string, renderId: string): Grade | null {
  const obj = extractJsonObject(text);
  if (obj === undefined || typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;

  // Clamp scores to 0–10 BEFORE schema validation — GradeSchema's ScoreSchema
  // rejects out-of-range numbers, so a model that returns 15 or -3 would
  // otherwise be treated as malformed and trigger an unnecessary reprompt.
  const rawScores =
    typeof record.scores === "object" && record.scores !== null
      ? (record.scores as Record<string, unknown>)
      : {};
  const clampedScores: Record<string, unknown> = { ...rawScores };
  for (const d of RUBRIC_DIMENSIONS) {
    const v = rawScores[d];
    if (typeof v === "number") clampedScores[d] = clamp(v);
  }

  // Stamp renderId ourselves so the grade is keyed to the render even if the
  // model omits or garbles it.
  const candidate = { ...record, scores: clampedScores, renderId };
  const parsed = GradeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Factory: build the verifier `grade` function with an injected LLM + exec.
 * The returned fn matches `LoopDeps.grade`: (render, rubric) => Promise<Grade>.
 */
export function makeGrade(
  llm: LlmClient,
  opts: MakeGradeOptions,
): (render: RenderResult, rubric: Rubric) => Promise<Grade> {
  return async (render: RenderResult, rubric: Rubric): Promise<Grade> => {
    try {
      const frames = await extractKeyframes(render.output, opts.exec, opts.frameOptions);
      // Prefer the prose-rich loaded rubric for the prompt when provided.
      const promptRubric = opts.rubric ?? rubric;
      const prompt = buildVerifierPrompt(promptRubric, frames);

      // First attempt.
      const first = await llm.complete({ ...prompt, maxTokens: GRADE_MAX_TOKENS });
      const firstGrade = tryParseGrade(first, render.renderId);
      if (firstGrade) return firstGrade;

      // One reprompt: restate the contract, nudge toward strict JSON.
      const repromptUser =
        prompt.user +
        "\n\nYour previous reply was not valid JSON in the required shape. " +
        "Reply with ONLY the JSON object — no markdown, no commentary.";
      const second = await llm.complete({
        ...prompt,
        user: repromptUser,
        maxTokens: GRADE_MAX_TOKENS,
      });
      const secondGrade = tryParseGrade(second, render.renderId);
      if (secondGrade) return secondGrade;

      // Unrecoverable: malformed twice.
      return sentinelGrade(render.renderId);
    } catch {
      // Unrecoverable: extraction threw, LLM threw, etc.
      return sentinelGrade(render.renderId);
    }
  };
}

/** Exposed for unit tests of the JSON-extraction + clamp path. */
export const __test = { extractJsonObject, tryParseGrade, sentinelGrade, clamp };
