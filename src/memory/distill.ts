/**
 * Memory — the OUTER loop, distill half (PRD §3/§14, plan Component 3).
 *
 * After a run PASSES, the agent distills exactly one verified rule and persists
 * it under `<dir>/<style>/`. The next run's `consult` reads it back — that's the
 * fail→distill→consult progression that makes the agent better across runs.
 *
 * The directory is INJECTED so unit tests use a temp dir; we create it on demand.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Grade } from "../loop/types.js";
import { styleDir, type Rule } from "./consult.js";

/** The minimal run shape distill needs (matches a `runs` row / claim). */
export interface DistillRun {
  id: string;
  style: string;
}

/**
 * Derive one human-readable rule from a passing run's grades. Picks the
 * lowest-scoring dimension that still passed — the closest call — and turns it
 * into guidance to reinforce next time. Falls back to a generic on-style rule.
 */
export function deriveRule(run: DistillRun, grades: Grade, now: number): Rule {
  const entries = Object.entries(grades.scores) as [string, number][];
  const weakest = entries.reduce<[string, number] | null>(
    (lo, cur) => (lo === null || cur[1] < lo[1] ? cur : lo),
    null,
  );
  const text = weakest
    ? `For ${run.style}: keep reinforcing "${weakest[0].replace(/_/g, " ")}" — it was the closest call (scored ${weakest[1]}) on the winning cut.`
    : `For ${run.style}: the winning cut passed every dimension — repeat this structure.`;
  return { text, source: run.id, ts: now };
}

/**
 * Write one verified rule for a passing run. Each rule is its own JSON file
 * (named by run id) so concurrent/repeat runs append rather than clobber, and
 * `consult` can read the directory back. Creates the style dir on demand.
 */
export async function distill(
  dir: string,
  style: string,
  run: DistillRun,
  grades: Grade,
  now: number = Date.now(),
): Promise<void> {
  const target = styleDir(dir, style);
  await mkdir(target, { recursive: true });
  const rule = deriveRule(run, grades, now);
  const file = join(target, `${run.id}.json`);
  await writeFile(file, JSON.stringify(rule, null, 2), "utf8");
}
