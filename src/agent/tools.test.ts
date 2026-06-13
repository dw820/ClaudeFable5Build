import { describe, it, expect } from "vitest";
import { ClipLibrarySchema, EdlSchema, RUBRIC_DIMENSIONS } from "../loop/types.js";
import type { LoopEvent } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls, createAutocutTools, formatClipInspection } from "./tools.js";
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

  it("exposes the six tools with mcp__autocut__ allowedTools", () => {
    const { specs, allowedTools } = setup();
    expect(specs.map((s) => s.name).sort()).toEqual(
      ["build_edl", "grade", "inspect_clip", "publish", "render", "search_clips"],
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

describe("formatClipInspection", () => {
  const clip = (over: Record<string, unknown> = {}) =>
    ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 4, duration: 4,
        resolution: [1080, 1920], caption: "a vlog", tags: ["vlog"],
        transcript: [], scenes: undefined, ...over,
      }],
    }).clips[0]!;

  it("renders duration, resolution, and per-scene transcript aligned to windows", () => {
    const out = formatClipInspection(clip({
      scenes: [
        { t0: 0, t1: 2, caption: "intro at desk", tags: ["indoor"] },
        { t0: 2, t1: 4, caption: "outro outside", tags: ["outdoor"] },
      ],
      transcript: [
        { word: "hello", t0: 0.1, t1: 0.5 },
        { word: "world", t0: 0.6, t1: 1.0 },
        { word: "again", t0: 2.1, t1: 2.5 },
      ],
    }));
    expect(out).toContain("vlog1");
    expect(out).toContain("4.0s");
    expect(out).toContain("1080x1920");
    expect(out).toContain("0.0–2.0s: intro at desk");
    expect(out).toContain("hello world");
    expect(out).toContain("2.0–4.0s: outro outside");
    expect(out).toContain("again");
  });

  it("falls back to whole-clip transcript when the clip has no scenes", () => {
    const out = formatClipInspection(clip({
      transcript: [
        { word: "single", t0: 0.1, t1: 0.4 },
        { word: "take", t0: 0.5, t1: 0.9 },
      ],
    }));
    expect(out).toContain("single take");
    expect(out).toContain("4.0s");
  });

  it("notes the absence of transcript rather than emitting an empty quote", () => {
    const out = formatClipInspection(clip({
      scenes: [{ t0: 0, t1: 4, caption: "silent b-roll", tags: ["broll"] }],
      transcript: [],
    }));
    expect(out).toContain("silent b-roll");
    expect(out.toLowerCase()).toContain("no transcript");
  });
});

describe("inspect_clip tool", () => {
  function setup() {
    const events: LoopEvent[] = [];
    const library = ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 4, duration: 4,
        resolution: [1080, 1920], caption: "a vlog", tags: ["vlog"],
        transcript: [{ word: "hey", t0: 0.1, t1: 0.4 }],
        scenes: [{ t0: 0, t1: 4, caption: "talking head", tags: ["face"] }],
      }],
    });
    const tracker = new Tracker(VIRAL_RUBRIC);
    const { specs } = createAutocutTools({
      impls: makeStubToolImpls(),
      library,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: (e) => events.push({ ...e, ts: 0 }),
    });
    return { events, byName: (n: string) => specs.find((s) => s.name === n)! };
  }

  it("returns the inspection for a known clip and emits a select event", async () => {
    const { events, byName } = setup();
    const res = await byName("inspect_clip").handler({ clipId: "vlog1" });
    expect(res.content[0]!.text).toContain("talking head");
    expect(events.map((e) => e.phase)).toContain("select");
  });

  it("returns UNKNOWN_CLIP text (not a throw) for an unknown id", async () => {
    const { byName } = setup();
    const res = await byName("inspect_clip").handler({ clipId: "nope" });
    expect(res.content[0]!.text).toMatch(/UNKNOWN_CLIP/);
  });
});
