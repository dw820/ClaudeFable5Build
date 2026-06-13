import { describe, it, expect } from "vitest";
import { ClipLibrarySchema, EdlSchema, RUBRIC_DIMENSIONS } from "../loop/types.js";
import type { LoopEvent } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls, createAutocutTools } from "./tools.js";
import { Tracker } from "./tracker.js";

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

describe("createAutocutTools", () => {
  function setup() {
    const events: LoopEvent[] = [];
    const tracker = new Tracker(VIRAL_RUBRIC);
    const { specs, allowedTools } = createAutocutTools({
      impls: makeStubToolImpls(),
      library: SAMPLE_LIBRARY,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: (e) => events.push({ ...e, ts: 0 }),
    });
    const byName = (n: string) => specs.find((s) => s.name === n)!;
    return { events, tracker, specs, allowedTools, byName };
  }

  it("exposes the five tools with mcp__autocut__ allowedTools", () => {
    const { specs, allowedTools } = setup();
    expect(specs.map((s) => s.name).sort()).toEqual(
      ["build_edl", "grade", "publish", "render", "search_clips"],
    );
    expect(allowedTools).toContain("mcp__autocut__publish");
  });

  it("build_edl validates and caches; render+grade record best-so-far and emit", async () => {
    const { events, tracker, byName } = setup();
    await byName("search_clips").handler({ query: "hook" });
    const build = await byName("build_edl").handler({ clipIds: ["c01"], rationale: "x" });
    const edlId = /edlId=(\S+)/.exec(build.content[0]!.text)![1]!;
    const render = await byName("render").handler({ edlId });
    const renderId = /renderId=(\S+)/.exec(render.content[0]!.text)![1]!;
    const grade = await byName("grade").handler({ renderId });
    expect(grade.content[0]!.text).toMatch(/NOT YET/);
    expect(tracker.summarize("success").shipped?.render.renderId).toBe(renderId);
    expect(events.map((e) => e.phase)).toEqual(["select", "build", "render", "grade"]);
  });

  it("build_edl returns INVALID_EDL text (not a throw) on bad output", async () => {
    const events: LoopEvent[] = [];
    const tracker = new Tracker(VIRAL_RUBRIC);
    const badImpls = { ...makeStubToolImpls(), buildEdl: async () => ({ edlId: "bad", segments: [] }) };
    const { specs } = createAutocutTools({
      impls: badImpls,
      library: SAMPLE_LIBRARY,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: (e) => events.push({ ...e, ts: 0 }),
    });
    const out = await specs.find((s) => s.name === "build_edl")!.handler({ clipIds: ["c01"] });
    expect(out.content[0]!.text).toMatch(/INVALID_EDL/);
  });

  it("publish marks the tracker", async () => {
    const { tracker, byName } = setup();
    const build = await byName("build_edl").handler({ clipIds: ["c01"] });
    const edlId = /edlId=(\S+)/.exec(build.content[0]!.text)![1]!;
    const render = await byName("render").handler({ edlId });
    const renderId = /renderId=(\S+)/.exec(render.content[0]!.text)![1]!;
    const out = await byName("publish").handler({ renderId });
    expect(out.content[0]!.text).toMatch(/PUBLISHED/);
  });

  it("search_clips includes scene summaries when a clip has scenes", async () => {
    const library = ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 30, duration: 30,
        resolution: [1080, 1920], transcript: [], caption: "a vlog", tags: ["vlog"],
        scenes: [
          { t0: 0, t1: 9.5, caption: "unboxing on a desk", tags: ["product"] },
          { t0: 24, t1: 31, caption: "walking outside", tags: ["outdoor"] },
        ],
      }],
    });
    const tracker = new Tracker(VIRAL_RUBRIC);
    const { specs } = createAutocutTools({
      impls: makeStubToolImpls(),
      library,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: () => {},
    });
    const search = specs.find((s) => s.name === "search_clips")!;
    const res = await search.handler({ query: "anything" });
    expect(res.content[0]!.text).toContain("9.5s: unboxing on a desk");
  });
});
