/**
 * Memory outer-loop tests (offline, temp dirs — no network).
 * Proves the fail→distill→consult progression: a passing run writes a rule that
 * the next run's consult reads back. Empty/missing memory degrades to [].
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consult, distill, deriveRule, styleDir } from "./index.js";
import type { Grade } from "../loop/types.js";

const STYLE = "Viral Short";

const passingGrade = (over: Partial<Grade["scores"]> = {}): Grade => ({
  renderId: "render-2",
  scores: {
    hook_strength: 8,
    pace_cut_density: 9,
    caption_legibility: 7,
    loopability: 8,
    on_style_trend_fit: 9,
    ...over,
  },
  feedback: {},
});

describe("memory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "autocut-mem-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] for an empty / missing memory dir", async () => {
    expect(await consult(dir, STYLE)).toEqual([]);
    expect(await consult(join(dir, "does-not-exist"), STYLE)).toEqual([]);
  });

  it("distill writes a rule that consult reads back (round-trip)", async () => {
    await distill(dir, STYLE, { id: "run-1", style: STYLE }, passingGrade(), 1000);
    const rules = await consult(dir, STYLE);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ source: "run-1", ts: 1000 });
    expect(typeof rules[0]!.text).toBe("string");
    expect(rules[0]!.text.length).toBeGreaterThan(0);
  });

  it("accumulates one rule per run across two runs (oldest-first)", async () => {
    await distill(dir, STYLE, { id: "run-1", style: STYLE }, passingGrade(), 1000);
    await distill(dir, STYLE, { id: "run-2", style: STYLE }, passingGrade(), 2000);
    const rules = await consult(dir, STYLE);
    expect(rules.map((r) => r.source)).toEqual(["run-1", "run-2"]);
    expect(rules.map((r) => r.ts)).toEqual([1000, 2000]);
  });

  it("isolates rules by style slug", async () => {
    await distill(dir, "Viral Short", { id: "run-1", style: "Viral Short" }, passingGrade(), 1);
    await distill(dir, "Cinematic", { id: "run-2", style: "Cinematic" }, passingGrade(), 2);
    expect(await consult(dir, "Viral Short")).toHaveLength(1);
    expect(await consult(dir, "Cinematic")).toHaveLength(1);
    expect(styleDir(dir, "Viral Short")).toBe(join(dir, "viral-short"));
  });

  it("deriveRule highlights the closest-call dimension", () => {
    const rule = deriveRule(
      { id: "run-x", style: STYLE },
      passingGrade({ caption_legibility: 7 }),
      42,
    );
    expect(rule.source).toBe("run-x");
    expect(rule.ts).toBe(42);
    expect(rule.text).toContain("caption legibility");
  });

  it("ignores non-json and corrupt rule files", async () => {
    await distill(dir, STYLE, { id: "run-1", style: STYLE }, passingGrade(), 1000);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(styleDir(dir, STYLE), "notes.txt"), "ignore me", "utf8");
    await writeFile(join(styleDir(dir, STYLE), "broken.json"), "{not json", "utf8");
    const rules = await consult(dir, STYLE);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("run-1");
  });
});
