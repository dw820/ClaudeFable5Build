/**
 * Loads `rubrics/viral-short.json` into a typed object for the verifier.
 *
 * The on-disk rubric carries both the controller's `Rubric` shape (style +
 * passThreshold) and the per-dimension prose the verifier shows the director.
 * We validate it here so a malformed rubric file fails loudly at load, not as a
 * garbled prompt three steps later.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RUBRIC_DIMENSIONS } from "../loop/types.js";
import type { Rubric } from "../loop/controller.js";

/** Every rubric dimension must carry a prose description. */
const DimensionDescriptions = z.object(
  Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, z.string().min(1)])) as Record<
    (typeof RUBRIC_DIMENSIONS)[number],
    z.ZodString
  >,
);

export const RubricFileSchema = z.object({
  style: z.string().min(1),
  passThreshold: z.number().min(0).max(10),
  dimensions: DimensionDescriptions,
});
export type RubricFile = z.infer<typeof RubricFileSchema>;

/** The verifier's view of a rubric: controller `Rubric` + dimension prose. */
export interface LoadedRubric extends Rubric {
  dimensions: Record<(typeof RUBRIC_DIMENSIONS)[number], string>;
}

const DEFAULT_RUBRIC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "rubrics",
  "viral-short.json",
);

/** Parse already-loaded JSON into a LoadedRubric (pure; easy to unit test). */
export function parseRubric(raw: unknown): LoadedRubric {
  const file = RubricFileSchema.parse(raw);
  return {
    style: file.style,
    passThreshold: file.passThreshold,
    dimensions: file.dimensions,
  };
}

/** Read + parse the rubric JSON from disk (defaults to rubrics/viral-short.json). */
export function loadRubric(path: string = DEFAULT_RUBRIC_PATH): LoadedRubric {
  return parseRubric(JSON.parse(readFileSync(path, "utf8")));
}
