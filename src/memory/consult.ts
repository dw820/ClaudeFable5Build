/**
 * Memory — the OUTER loop, consult half (PRD §3/§14, plan Component 3).
 *
 * Distilled rules persist as JSON files on the agent's persistent disk, one
 * directory per style (`<dir>/<style>/*.json`). `consult` reads them back at the
 * start of a run to bias the brief/rubric; a missing or empty dir yields [] so
 * the very first run just proceeds with no prior wisdom.
 *
 * The directory is INJECTED (default `$MEMORY_DIR` or `./.memory`) so unit tests
 * point it at a temp dir and nothing touches a real path at import.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** A single distilled, verified rule learned from a passing run. */
export interface Rule {
  /** The actionable guidance, e.g. "Lead with a 2s hook". */
  text: string;
  /** Where it came from, e.g. a run id. */
  source: string;
  /** When it was distilled (epoch ms). */
  ts: number;
}

/** Default memory root: persistent Daytona path in prod, ./.memory locally. */
export const DEFAULT_MEMORY_DIR = process.env.MEMORY_DIR ?? "./.memory";

/** Slugify a style label into a safe directory name (e.g. "Viral Short"). */
export function styleDir(dir: string, style: string): string {
  const slug = style.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return join(dir, slug || "default");
}

function isRule(value: unknown): value is Rule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rule).text === "string" &&
    typeof (value as Rule).source === "string" &&
    typeof (value as Rule).ts === "number"
  );
}

/**
 * Read every distilled rule for a style. Missing dir, empty dir, or unreadable /
 * malformed files all degrade to fewer rules (never a throw) — memory is an
 * optimization, not a dependency. Rules are returned oldest-first (by `ts`).
 */
export async function consult(dir: string, style: string): Promise<Rule[]> {
  const target = styleDir(dir, style);
  let names: string[];
  try {
    names = await readdir(target);
  } catch {
    return []; // missing/empty memory for this style — first run
  }

  const rules: Rule[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(target, name), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const r of parsed) if (isRule(r)) rules.push(r);
      } else if (isRule(parsed)) {
        rules.push(parsed);
      }
    } catch {
      // skip a corrupt rule file rather than fail the run
    }
  }
  rules.sort((a, b) => a.ts - b.ts);
  return rules;
}
