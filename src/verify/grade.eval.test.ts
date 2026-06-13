/**
 * Discrimination eval for the director verifier (Lane C).
 *
 * Gated: runs only with ANTHROPIC_API_KEY + RUN_FFMPEG set (it calls the real
 * model and shells out to real ffmpeg). If the fixture videos are missing, run
 * `bash src/__fixtures__/generate.sh` first.
 *
 * The whole point of an INDEPENDENT verifier is that it can tell a good cut from
 * a bad one. So: good-cut.mp4 (big bright legible caption, punchy) should pass
 * most dimensions; weak-cut.mp4 (tiny dim caption, slow empty lead-in) should
 * fail. We assert good >= weak and that the gap is real, not the prompt leaking.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { makeGrade } from "./grade.js";
import { loadRubric } from "./rubric.js";
import { AnthropicClient } from "../llm/client.js";
import type { ExecFn } from "./frames.js";
import { RUBRIC_DIMENSIONS, type Grade, type RenderResult } from "../loop/types.js";
import type { Rubric } from "../loop/controller.js";

const execFileP = promisify(execFile);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");

/** Real ffmpeg/ffprobe runner returning stdout as a Buffer. */
const realExec: ExecFn = async (cmd, args) => {
  const { stdout } = await execFileP(cmd, args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout as Buffer;
};

const gated = !process.env.ANTHROPIC_API_KEY || !process.env.RUN_FFMPEG;

const passedCount = (g: Grade, threshold: number): number =>
  RUBRIC_DIMENSIONS.filter((d) => g.scores[d] >= threshold).length;

describe.skipIf(gated)("verifier discrimination eval (real model + ffmpeg)", () => {
  const rubric = loadRubric();
  const controllerRubric: Rubric = { style: rubric.style, passThreshold: rubric.passThreshold };

  const gradeOf = async (file: string): Promise<Grade> => {
    const path = join(fixtures, file);
    if (!existsSync(path)) {
      throw new Error(`Missing fixture ${file} — run: bash src/__fixtures__/generate.sh`);
    }
    const llm = new AnthropicClient();
    const grade = makeGrade(llm, { exec: realExec, rubric });
    const render: RenderResult = { renderId: file, output: path, usedFallback: false };
    return grade(render, controllerRubric);
  };

  it("good-cut.mp4 passes >= 4/5 dimensions", async () => {
    const grade = await gradeOf("good-cut.mp4");
    expect(grade.feedback._verifier).toBeUndefined(); // verifier actually ran
    expect(passedCount(grade, rubric.passThreshold)).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("weak-cut.mp4 fails (does not pass all dimensions)", async () => {
    const grade = await gradeOf("weak-cut.mp4");
    expect(grade.feedback._verifier).toBeUndefined();
    expect(passedCount(grade, rubric.passThreshold)).toBeLessThan(RUBRIC_DIMENSIONS.length);
  }, 120_000);

  it("good-cut outscores weak-cut overall", async () => {
    const [good, weak] = await Promise.all([gradeOf("good-cut.mp4"), gradeOf("weak-cut.mp4")]);
    const sum = (g: Grade) => RUBRIC_DIMENSIONS.reduce((s, d) => s + g.scores[d], 0);
    expect(sum(good)).toBeGreaterThan(sum(weak));
  }, 180_000);
});
