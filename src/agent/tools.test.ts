import { describe, it, expect } from "vitest";
import { EdlSchema, RUBRIC_DIMENSIONS } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls } from "./tools.js";

describe("makeStubToolImpls", () => {
  it("searchClips returns the library clips", async () => {
    const impls = makeStubToolImpls();
    const clips = await impls.searchClips("anything", SAMPLE_LIBRARY);
    expect(clips.map((c) => c.id)).toEqual(["c01", "c02"]);
  });

  it("buildEdl returns a schema-valid EDL", async () => {
    const impls = makeStubToolImpls();
    const raw = await impls.buildEdl(["c01"], "open on the hook", SAMPLE_LIBRARY);
    expect(EdlSchema.safeParse(raw).success).toBe(true);
  });

  it("render returns a unique ref each call", async () => {
    const impls = makeStubToolImpls();
    const edl = EdlSchema.parse(await impls.buildEdl(["c01"], "", SAMPLE_LIBRARY));
    const r1 = await impls.render(edl);
    const r2 = await impls.render(edl);
    expect(r1.output).not.toEqual(r2.output);
  });

  it("grade follows a weak-then-pass script", async () => {
    const impls = makeStubToolImpls();
    const edl = EdlSchema.parse(await impls.buildEdl(["c01"], "", SAMPLE_LIBRARY));
    const r = await impls.render(edl);
    const g1 = await impls.grade(r, VIRAL_RUBRIC);
    const g2 = await impls.grade(r, VIRAL_RUBRIC);
    const passes = (g: typeof g1) => RUBRIC_DIMENSIONS.every((d) => g.scores[d] >= VIRAL_RUBRIC.passThreshold);
    expect(passes(g1)).toBe(false);
    expect(passes(g2)).toBe(true);
  });
});
