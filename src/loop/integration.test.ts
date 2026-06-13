/**
 * Integration: the deps.ts factory composes the REAL lane modules into LoopDeps,
 * and the controller drives them end to end.
 *
 * The offline test fakes only the binaries (ffmpeg) and the LLM — the real
 * builder (JSON parse + post-filter), real verifier (frame plumbing + GradeSchema
 * parse), real render composition, and real controller all run. That proves the
 * seams line up, with no ffmpeg and no API key.
 *
 * The gated e2e test runs the actual modules against real ffmpeg + Claude.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { runLoop, type Rubric } from "./controller.js";
import { createLoopDeps } from "./deps.js";
import { ClipLibrarySchema, type ClipLibrary, type LoopEvent } from "./types.js";
import { FakeLlmClient } from "../llm/client.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const library: ClipLibrary = ClipLibrarySchema.parse(
  JSON.parse(readFileSync(join(fixtures, "sample-clips.json"), "utf8")),
);
const rubric: Rubric = { style: "Viral Short", passThreshold: 7 };
const brief = "30s Viral Short, open on the wipeout, build to sunset";

// A schema-valid EDL the fake "builder LLM" returns (real clip ids, ~30s).
const BUILDER_EDL = JSON.stringify({
  edlId: "edl-int-1",
  aspect: "9:16",
  targetLenS: 30,
  lut: null,
  segments: [
    { clipId: "c01", in: 0, out: 6, transition: "cut", captions: [{ text: "watch this", t0: 0, t1: 1.5, style: "bold-center" }] },
    { clipId: "c08", in: 0, out: 6, transition: "cut", captions: [] },
    { clipId: "c06", in: 0, out: 8, transition: "cut", captions: [] },
    { clipId: "c02", in: 0, out: 10, transition: "cut", captions: [] },
  ],
  selectionRationale: "hook on the wipeout, build to the sunset",
});
const PASSING_GRADE = JSON.stringify({
  scores: { hook_strength: 9, pace_cut_density: 9, caption_legibility: 8, loopability: 8, on_style_trend_fit: 9 },
  feedback: {},
});

describe("integration — deps factory wires real modules", () => {
  it("runs the full loop offline (real builder + verify-parse + render, faked ffmpeg/LLM)", async () => {
    const events: LoopEvent[] = [];
    // Call 0 = builder (EDL); call 1+ = verifier (grade). FakeLlm repeats the last.
    const llm = new FakeLlmClient([BUILDER_EDL, PASSING_GRADE]);

    const deps = createLoopDeps({
      library,
      llm,
      emit: (e) => events.push(e),
      cutVideo: async (edl) => ({ path: `/tmp/${edl.edlId}.mp4`, durationS: edl.targetLenS }),
      applyOverlay: async (basePath) => ({ path: basePath, usedFallback: false }),
      frameExec: async () => Buffer.from("fake-jpeg-bytes"),
      frameOptions: { durationS: 3, count: 1 },
    });

    const result = await runLoop({ brief, rubric, library }, deps, {
      maxIters: 4,
      passThreshold: 7,
    });

    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.shipped?.render.output).toBe("/tmp/edl-int-1.mp4");
    expect(events.some((e) => e.phase === "ship")).toBe(true);
    // The verifier actually parsed our grade JSON into a real Grade.
    expect(result.shipped?.grade.scores.hook_strength).toBe(9);
  });

  it("ships best-so-far (never nothing) when the verifier keeps failing offline", async () => {
    const failing = JSON.stringify({
      scores: { hook_strength: 3, pace_cut_density: 4, caption_legibility: 3, loopability: 4, on_style_trend_fit: 3 },
      feedback: { hook_strength: "weak hook" },
    });
    const llm = new FakeLlmClient((opts) =>
      // The verifier always sends keyframe images; the builder never does.
      opts.images && opts.images.length > 0 ? failing : BUILDER_EDL,
    );
    const deps = createLoopDeps({
      library,
      llm,
      cutVideo: async (edl) => ({ path: `/tmp/${edl.edlId}.mp4`, durationS: edl.targetLenS }),
      applyOverlay: async (basePath) => ({ path: basePath, usedFallback: false }),
      frameExec: async () => Buffer.from("x"),
      frameOptions: { durationS: 3, count: 1 },
    });
    const result = await runLoop({ brief, rubric, library }, deps, { maxIters: 3, passThreshold: 7 });
    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("max-iters");
    expect(result.shipped).not.toBeNull(); // best-so-far always ships
  });
});

describe.skipIf(!process.env.RUN_FFMPEG || !process.env.ANTHROPIC_API_KEY)(
  "integration — real e2e (ffmpeg + Claude)",
  () => {
    it("drives the real loop and ships a render", async () => {
      const { AnthropicClient } = await import("../llm/client.js");
      const deps = createLoopDeps({ library, llm: new AnthropicClient() });
      const result = await runLoop({ brief, rubric, library }, deps, {
        maxIters: 3,
        passThreshold: 7,
        wallclockMs: 180_000,
      });
      expect(result.shipped).not.toBeNull();
    }, 200_000);
  },
);
