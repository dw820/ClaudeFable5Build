import { describe, it, expect } from "vitest";
import { makeRealToolImpls } from "./realTools.js";
import { FakeLlmClient } from "../llm/client.js";
import type { BuildContext } from "../loop/controller.js";
import type { ClipLibrary, Edl, Grade, RenderResult } from "../loop/types.js";
import { VIRAL_RUBRIC } from "../loop/stubs.js";

const LIB: ClipLibrary = {
  projectId: "fixture",
  clips: [
    { id: "c01", src: "a.mp4", start: 0, end: 6, duration: 6, resolution: [1080, 1920], transcript: [], caption: "hook", tags: ["a"] },
    { id: "c02", src: "b.mp4", start: 0, end: 8, duration: 8, resolution: [1080, 1920], transcript: [], caption: "broll", tags: ["b"] },
    { id: "c03", src: "c.mp4", start: 0, end: 5, duration: 5, resolution: [1080, 1920], transcript: [], caption: "end", tags: ["c"] },
  ],
};

function makeWithSpyBuild() {
  const captured: BuildContext[] = [];
  const impls = makeRealToolImpls({
    llm: new FakeLlmClient([""]),
    library: LIB,
    brief: "Make a viral short",
    rubric: VIRAL_RUBRIC,
    buildEdl: async (ctx) => {
      captured.push(ctx);
      return { edlId: "edl-x" };
    },
  });
  return { impls, captured };
}

describe("makeRealToolImpls", () => {
  it("searchClips returns the library's clips (stub passthrough)", async () => {
    const { impls } = makeWithSpyBuild();
    const clips = await impls.searchClips("anything", LIB);
    expect(clips.map((c) => c.id)).toEqual(["c01", "c02", "c03"]);
  });

  it("buildEdl scopes the BuildContext library to the selected clipIds", async () => {
    const { impls, captured } = makeWithSpyBuild();
    const out = await impls.buildEdl(["c01", "c03"], "lead with the hook", LIB);
    expect(out).toEqual({ edlId: "edl-x" });
    expect(captured[0]!.library.clips.map((c) => c.id)).toEqual(["c01", "c03"]);
  });

  it("buildEdl folds the rationale into the brief and increments iteration", async () => {
    const { impls, captured } = makeWithSpyBuild();
    await impls.buildEdl(["c01"], "punchy open", LIB);
    await impls.buildEdl(["c02"], "", LIB);
    expect(captured[0]!.brief).toContain("Make a viral short");
    expect(captured[0]!.brief).toContain("punchy open");
    expect(captured[0]!.iteration).toBe(1);
    expect(captured[1]!.iteration).toBe(2);
    expect(captured[1]!.brief).toBe("Make a viral short");
  });

  it("buildEdl falls back to the full library when clipIds is empty", async () => {
    const { impls, captured } = makeWithSpyBuild();
    await impls.buildEdl([], "", LIB);
    expect(captured[0]!.library.clips.map((c) => c.id)).toEqual(["c01", "c02", "c03"]);
  });

  it("render and grade delegate to the injected implementations", async () => {
    const render: RenderResult = { renderId: "r1", output: "/tmp/r1.mp4", usedFallback: true };
    const grade: Grade = { renderId: "r1", scores: { hook_strength: 8, pace_cut_density: 8, caption_legibility: 8, loopability: 8, on_style_trend_fit: 8 }, feedback: {} };
    const impls = makeRealToolImpls({
      llm: new FakeLlmClient([""]),
      library: LIB,
      brief: "b",
      rubric: VIRAL_RUBRIC,
      render: async (_edl: Edl) => render,
      grade: async (_r: RenderResult) => grade,
    });
    const r = await impls.render({} as Edl);
    expect(r).toBe(render);
    const g = await impls.grade(render, VIRAL_RUBRIC);
    expect(g).toBe(grade);
  });
});
