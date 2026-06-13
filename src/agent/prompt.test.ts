import { describe, it, expect } from "vitest";
import { RUBRIC_DIMENSIONS } from "../loop/types.js";
import { VIRAL_RUBRIC } from "../loop/stubs.js";
import { buildSystemPrompt } from "./prompt.js";

describe("buildSystemPrompt", () => {
  it("includes the brief, every rubric dimension, threshold, and the grade-before-publish rule", () => {
    const p = buildSystemPrompt("Make a 20s beach short", VIRAL_RUBRIC);
    expect(p).toContain("Make a 20s beach short");
    expect(p).toContain(String(VIRAL_RUBRIC.passThreshold));
    for (const d of RUBRIC_DIMENSIONS) expect(p).toContain(d);
    expect(p.toLowerCase()).toContain("grade every render before");
    expect(p.toLowerCase()).toContain("publish");
  });
});
