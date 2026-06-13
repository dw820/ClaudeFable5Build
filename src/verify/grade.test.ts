/**
 * Unit tests for the director verifier (Lane C) — no ffmpeg, no API key.
 *
 * The exec runner and LlmClient are both faked, so these run in-process. The
 * load-bearing assertions are:
 *   - independence: the prompt carries the rubric + frames and NO EDL/segment/
 *     clipId/builder-rationale text;
 *   - valid JSON parses to a Grade;
 *   - malformed → reprompt (one retry) → parse;
 *   - unrecoverable (LLM throws both times) → sentinel tagged _verifier;
 *   - scores are clamped to 0–10.
 */
import { describe, it, expect } from "vitest";
import { makeGrade } from "./grade.js";
import { buildVerifierPrompt } from "./prompt.js";
import { FakeLlmClient, type LlmImage } from "../llm/client.js";
import type { ExecFn } from "./frames.js";
import type { Rubric } from "../loop/controller.js";
import { RUBRIC_DIMENSIONS, type RenderResult } from "../loop/types.js";

const RUBRIC: Rubric = { style: "Viral Short", passThreshold: 7 };
const RENDER: RenderResult = { renderId: "r1", output: "/tmp/out.mp4", usedFallback: false };

/** Fake exec: ffprobe → a duration, ffmpeg → fixed jpeg bytes. */
const fakeExec: ExecFn = async (cmd) => {
  if (cmd.includes("ffprobe")) return Buffer.from("4.0\n");
  return Buffer.from(`jpeg-bytes-${Math.random()}`);
};

const goodJson = (overrides: Partial<Record<string, number>> = {}): string =>
  JSON.stringify({
    scores: Object.fromEntries(
      RUBRIC_DIMENSIONS.map((d) => [d, overrides[d] ?? 8]),
    ),
    feedback: { hook_strength: "land the punchline sooner" },
  });

describe("buildVerifierPrompt — independence", () => {
  const frames: LlmImage[] = [{ mediaType: "image/jpeg", dataBase64: "AAAA" }];
  const prompt = buildVerifierPrompt(RUBRIC, frames);
  const blob = `${prompt.system}\n${prompt.user}`.toLowerCase();

  it("includes every rubric dimension", () => {
    for (const d of RUBRIC_DIMENSIONS) expect(prompt.user).toContain(d);
  });

  it("attaches the frames as images", () => {
    expect(prompt.images).toBe(frames);
    expect(prompt.images).toHaveLength(1);
  });

  it("contains NO EDL / segment / clipId / builder-rationale leakage", () => {
    // Real builder-state leakage markers — not the reserved feedback key `_edl`,
    // which legitimately appears as a valid feedback key name.
    for (const banned of ["edlid", "segment", "clipid", "transition", "rationale", "crossfade"]) {
      expect(blob).not.toContain(banned);
    }
    // The only `edl` substring permitted is the reserved key `_edl`.
    expect(blob.replaceAll("_edl", "")).not.toContain("edl");
  });

  it("asks for the GradeSchema JSON shape (scores + feedback)", () => {
    expect(prompt.user).toContain('"scores"');
    expect(prompt.user).toContain('"feedback"');
  });
});

describe("makeGrade", () => {
  it("parses a valid JSON response into a Grade", async () => {
    const llm = new FakeLlmClient([goodJson()]);
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);

    expect(result.renderId).toBe("r1");
    for (const d of RUBRIC_DIMENSIONS) expect(result.scores[d]).toBe(8);
    expect(result.feedback.hook_strength).toBe("land the punchline sooner");
  });

  it("never receives an EDL: the prompt the LLM saw is independent", async () => {
    const llm = new FakeLlmClient([goodJson()]);
    const grade = makeGrade(llm, { exec: fakeExec });
    await grade(RENDER, RUBRIC);

    const seen = `${llm.lastOptions?.system}\n${llm.lastOptions?.user}`.toLowerCase();
    for (const banned of ["edlid", "segment", "clipid", "rationale", "crossfade"]) {
      expect(seen).not.toContain(banned);
    }
    expect(seen.replaceAll("_edl", "")).not.toContain("edl");
    // It DID see frames + the rubric.
    expect(llm.lastOptions?.images).toHaveLength(5);
    expect(llm.lastOptions?.user).toContain("hook_strength");
  });

  it("extracts KEYFRAME_COUNT frames via the injected exec", async () => {
    const llm = new FakeLlmClient([goodJson()]);
    const grade = makeGrade(llm, { exec: fakeExec });
    await grade(RENDER, RUBRIC);
    expect(llm.lastOptions?.images).toHaveLength(5);
  });

  it("reprompts ONCE on malformed output, then parses the retry", async () => {
    const llm = new FakeLlmClient(["not json at all", goodJson()]);
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);

    expect(result.feedback._verifier).toBeUndefined();
    expect(result.scores.hook_strength).toBe(8);
    expect(llm.seenOptions).toHaveLength(2);
    // The reprompt restates the strict-JSON instruction.
    expect(llm.seenOptions[1]?.user).toContain("valid JSON");
  });

  it("returns the sentinel after malformed TWICE (no third call)", async () => {
    const llm = new FakeLlmClient(["garbage", "still garbage"]);
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);

    expect(llm.seenOptions).toHaveLength(2);
    expect(result.feedback._verifier).toBe("unavailable");
    for (const d of RUBRIC_DIMENSIONS) expect(result.scores[d]).toBe(0);
  });

  it("returns the sentinel when the LLM throws both times", async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error("api down");
    });
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);

    expect(result.renderId).toBe("r1");
    expect(result.feedback._verifier).toBe("unavailable");
    for (const d of RUBRIC_DIMENSIONS) expect(result.scores[d]).toBe(0);
  });

  it("returns the sentinel when keyframe extraction (exec) throws", async () => {
    const throwingExec: ExecFn = async () => {
      throw new Error("ffmpeg missing");
    };
    const llm = new FakeLlmClient([goodJson()]);
    const grade = makeGrade(llm, { exec: throwingExec });
    const result = await grade(RENDER, RUBRIC);

    expect(result.feedback._verifier).toBe("unavailable");
    // The LLM was never reached.
    expect(llm.seenOptions).toHaveLength(0);
  });

  it("clamps out-of-range scores to 0–10", async () => {
    const wild = JSON.stringify({
      scores: {
        hook_strength: 15,
        pace_cut_density: -4,
        caption_legibility: 7,
        loopability: 100,
        on_style_trend_fit: 0,
      },
      feedback: {},
    });
    const llm = new FakeLlmClient([wild]);
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);

    expect(result.scores.hook_strength).toBe(10);
    expect(result.scores.pace_cut_density).toBe(0);
    expect(result.scores.caption_legibility).toBe(7);
    expect(result.scores.loopability).toBe(10);
    expect(result.scores.on_style_trend_fit).toBe(0);
  });

  it("tolerates JSON wrapped in prose / markdown fences", async () => {
    const fenced = "Here is my assessment:\n```json\n" + goodJson() + "\n```\nThanks!";
    const llm = new FakeLlmClient([fenced]);
    const grade = makeGrade(llm, { exec: fakeExec });
    const result = await grade(RENDER, RUBRIC);
    expect(result.scores.hook_strength).toBe(8);
    expect(llm.seenOptions).toHaveLength(1); // parsed on first try, no reprompt
  });
});
