/**
 * Unit tests for the EDL builder (Lane D), driven by FakeLlmClient.
 *
 * Covers: the prompt carries clip ids + rubric dimensions; iteration > 1 wires
 * previousFeedback into the prompt (self-correction); a well-formed model
 * response parses and passes EdlSchema with clipIds ⊆ library and duration
 * within tolerance; and a CONTRACT test that the feedback keys the builder
 * consumes are the RUBRIC_DIMENSIONS the verifier emits.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeLlmClient } from "../llm/client.js";
import type { BuildContext, Rubric } from "../loop/controller.js";
import {
  ClipLibrarySchema,
  EdlSchema,
  RUBRIC_DIMENSIONS,
  type ClipLibrary,
  type Edl,
} from "../loop/types.js";
import { withinTargetLen } from "../constants.js";
import { makeBuildEdl } from "./build.js";
import { buildPrompt, DEFAULT_ASPECT, DEFAULT_TARGET_LEN_S } from "./prompt.js";

const library: ClipLibrary = ClipLibrarySchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../__fixtures__/sample-clips.json", import.meta.url)),
      "utf8",
    ),
  ),
);

const rubric: Rubric = { style: "Viral Short", passThreshold: 7 };

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    brief: "A high-energy beach surf trip montage",
    rubric,
    library,
    iteration: 1,
    ...overrides,
  };
}

/** A well-formed EDL response referencing real clip ids, ~20s total. */
function goodEdlResponse(): string {
  const edl: Edl = {
    edlId: "edl-1",
    aspect: DEFAULT_ASPECT,
    targetLenS: DEFAULT_TARGET_LEN_S,
    lut: null,
    segments: [
      { clipId: "c01", in: 0, out: 5, transition: "cut", captions: [] },
      { clipId: "c08", in: 0, out: 5, transition: "cut", captions: [] },
      { clipId: "c04", in: 0, out: 5, transition: "crossfade", captions: [] },
      { clipId: "c05", in: 0, out: 5, transition: "cut", captions: [] },
    ],
    selectionRationale: "hook → action → texture → reaction loops back",
  };
  return JSON.stringify(edl);
}

describe("buildPrompt (pure)", () => {
  it("includes every clip id and the rubric dimensions", () => {
    const prompt = buildPrompt(ctx());
    for (const clip of library.clips) {
      expect(prompt.user).toContain(clip.id);
    }
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(prompt.user).toContain(dim);
    }
    expect(prompt.user).toContain(rubric.style);
    expect(prompt.system).toMatch(/short-form/i);
  });

  it("omits self-correction text on the first iteration", () => {
    const prompt = buildPrompt(ctx({ iteration: 1 }));
    expect(prompt.user).not.toMatch(/REVISION/i);
  });

  it("includes previousFeedback text on iteration > 1 (self-correction wiring)", () => {
    const prompt = buildPrompt(
      ctx({
        iteration: 2,
        previousFeedback: {
          hook_strength: "Open on the wipeout, not the calm sunset.",
          loopability: "End on a clip that matches the opening framing.",
        },
        previousEdl: EdlSchema.parse(JSON.parse(goodEdlResponse())),
      }),
    );
    expect(prompt.user).toMatch(/REVISION/i);
    expect(prompt.user).toContain("hook_strength");
    expect(prompt.user).toContain("Open on the wipeout");
    expect(prompt.user).toContain("loopability");
    // Previous EDL is summarized for context.
    expect(prompt.user).toContain("c01");
  });

  it("renders timed scene lines when a clip has more than one scene", () => {
    const lib: ClipLibrary = ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 30, duration: 30,
        resolution: [1080, 1920], transcript: [], caption: "a vlog", tags: ["vlog"],
        scenes: [
          { t0: 0, t1: 9.5, caption: "unboxing on a desk", tags: ["product"] },
          { t0: 9.5, t1: 30, caption: "walking outside", tags: ["outdoor"] },
        ],
      }],
    });
    const prompt = buildPrompt(ctx({ library: lib }));
    expect(prompt.user).toContain("scenes:");
    expect(prompt.user).toContain('0.0–9.5s: "unboxing on a desk"');
    expect(prompt.user).toContain('9.5–30.0s: "walking outside"');
  });
});

describe("makeBuildEdl", () => {
  it("parses a well-formed response into a schema-valid EDL", async () => {
    const llm = new FakeLlmClient([goodEdlResponse()]);
    const buildEdl = makeBuildEdl(llm);

    const result = await buildEdl(ctx());
    const parsed = EdlSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("passes the clip ids and rubric to the model", async () => {
    const llm = new FakeLlmClient([goodEdlResponse()]);
    await makeBuildEdl(llm)(ctx());

    expect(llm.lastOptions).toBeDefined();
    expect(llm.lastOptions!.user).toContain("c01");
    expect(llm.lastOptions!.user).toContain(rubric.style);
  });

  it("keeps clipIds a subset of the library", async () => {
    const llm = new FakeLlmClient([goodEdlResponse()]);
    const result = await makeBuildEdl(llm)(ctx());
    const edl = EdlSchema.parse(result);

    const ids = new Set(library.clips.map((c) => c.id));
    for (const seg of edl.segments) {
      expect(ids.has(seg.clipId)).toBe(true);
    }
  });

  it("drops segments whose clipId is not in the library", async () => {
    const withGhost: Edl = EdlSchema.parse(JSON.parse(goodEdlResponse()));
    const response = JSON.stringify({
      ...withGhost,
      segments: [
        ...withGhost.segments,
        { clipId: "DOES_NOT_EXIST", in: 0, out: 4, transition: "cut", captions: [] },
      ],
    });

    const result = await makeBuildEdl(new FakeLlmClient([response]))(ctx());
    const edl = EdlSchema.parse(result);
    const ids = new Set(library.clips.map((c) => c.id));
    expect(edl.segments.every((s) => ids.has(s.clipId))).toBe(true);
    expect(edl.segments.some((s) => s.clipId === "DOES_NOT_EXIST")).toBe(false);
  });

  it("forces lut to null even when the model emits a descriptive name", async () => {
    // The model often invents a LUT name (e.g. "punchy-cool-contrast"), which the
    // renderer would treat as a missing .cube file and fail. No .cube LUT files
    // exist this increment, so the builder must null it.
    const withLut: Edl = EdlSchema.parse(JSON.parse(goodEdlResponse()));
    const response = JSON.stringify({ ...withLut, lut: "punchy-cool-contrast" });

    const result = await makeBuildEdl(new FakeLlmClient([response]))(ctx());
    const edl = EdlSchema.parse(result);
    expect(edl.lut).toBe(null);
  });

  it("nudges an over-long EDL back within target tolerance", async () => {
    // 4 segments × 10s = 40s, target is 20s — must be trimmed toward target.
    const longEdl: Edl = {
      edlId: "edl-long",
      aspect: DEFAULT_ASPECT,
      targetLenS: DEFAULT_TARGET_LEN_S,
      lut: null,
      segments: [
        { clipId: "c01", in: 0, out: 10, transition: "cut", captions: [] },
        { clipId: "c06", in: 0, out: 10, transition: "cut", captions: [] },
        { clipId: "c02", in: 0, out: 10, transition: "cut", captions: [] },
        { clipId: "c10", in: 0, out: 10, transition: "cut", captions: [] },
      ],
      selectionRationale: "too long on purpose",
    };
    const result = await makeBuildEdl(new FakeLlmClient([JSON.stringify(longEdl)]))(ctx());
    const edl = EdlSchema.parse(result);
    expect(withinTargetLen(edl)).toBe(true);
  });

  it("nudges a too-short EDL up toward target tolerance", async () => {
    // 3 segments × 2s = 6s, target 20s — extend toward each clip's duration.
    const shortEdl: Edl = {
      edlId: "edl-short",
      aspect: DEFAULT_ASPECT,
      targetLenS: DEFAULT_TARGET_LEN_S,
      lut: null,
      segments: [
        { clipId: "c06", in: 0, out: 2, transition: "cut", captions: [] }, // dur 20
        { clipId: "c02", in: 0, out: 2, transition: "cut", captions: [] }, // dur 18
        { clipId: "c01", in: 0, out: 2, transition: "cut", captions: [] }, // dur 12
      ],
      selectionRationale: "too short on purpose",
    };
    const result = await makeBuildEdl(new FakeLlmClient([JSON.stringify(shortEdl)]))(ctx());
    const edl = EdlSchema.parse(result);
    expect(withinTargetLen(edl)).toBe(true);
  });

  it("a well-formed response yields a duration within tolerance", async () => {
    const result = await makeBuildEdl(new FakeLlmClient([goodEdlResponse()]))(ctx());
    const edl = EdlSchema.parse(result);
    expect(withinTargetLen(edl)).toBe(true);
  });

  it("extracts JSON from a response wrapped in markdown fences", async () => {
    const fenced = "Here is the EDL:\n```json\n" + goodEdlResponse() + "\n```\n";
    const result = await makeBuildEdl(new FakeLlmClient([fenced]))(ctx());
    expect(EdlSchema.safeParse(result).success).toBe(true);
  });

  it("does not throw on an unparseable response (controller bounces it)", async () => {
    const result = await makeBuildEdl(new FakeLlmClient(["not json at all"]))(ctx());
    // Returned as-is; the schema will reject it at the controller.
    expect(EdlSchema.safeParse(result).success).toBe(false);
  });
});

describe("contract: feedback keys are RUBRIC_DIMENSIONS", () => {
  it("renders feedback keyed by every rubric dimension the verifier may emit", () => {
    // The verifier emits feedback keyed by RUBRIC_DIMENSIONS values; the builder
    // must surface those exact keys in its self-correction prompt.
    const feedback = Object.fromEntries(
      RUBRIC_DIMENSIONS.map((d) => [d, `fix ${d}`]),
    );
    const prompt = buildPrompt(ctx({ iteration: 2, previousFeedback: feedback }));
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(prompt.user).toContain(dim);
      expect(prompt.user).toContain(`fix ${dim}`);
    }
  });
});
