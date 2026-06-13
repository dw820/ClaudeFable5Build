/**
 * LoopDeps factory — wires the real modules (built by the 5 lanes) into the
 * shape the controller injects. This is the integration seam: nothing above it
 * knows about ffmpeg/Claude; nothing below it knows about the loop.
 *
 *   buildEdl ← builder/makeBuildEdl(llm)
 *   render   ← render/makeRender(library, { edit/cutVideo, overlay/applyOverlay })
 *   grade    ← verify/makeGrade(llm, { exec })
 *   emit     ← caller (Supabase Realtime writer in prod; collector in tests)
 *
 * Render pieces, the frame-extraction exec, and the LLM are overridable so the
 * wiring can be exercised offline (no ffmpeg, no API key).
 */
import { spawn } from "node:child_process";
import type { ClipLibrary, LoopEvent } from "./types.js";
import type { LoopDeps } from "./controller.js";
import type { LlmClient } from "../llm/client.js";
import { makeRender } from "../render/render.js";
import { cutVideo as realCutVideo } from "../edit/cut.js";
import { applyOverlay as realApplyOverlay } from "../overlay/overlay.js";
import { makeGrade } from "../verify/grade.js";
import type { ExecFn, FrameExtractOptions } from "../verify/frames.js";
import type { LoadedRubric } from "../verify/rubric.js";
import { makeBuildEdl } from "../builder/build.js";

/** Real exec: spawn a command, resolve its stdout bytes (ffmpeg/ffprobe). */
export const defaultExec: ExecFn = (cmd, args) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-300)}`)),
    );
  });

export interface CreateLoopDepsOptions {
  library: ClipLibrary;
  llm: LlmClient;
  emit?: (event: LoopEvent) => void;
  /** Loaded rubric prose for richer verifier prompts (optional). */
  rubric?: LoadedRubric;
  /** Overrides (default to the real modules) — set in offline tests. */
  cutVideo?: typeof realCutVideo;
  applyOverlay?: typeof realApplyOverlay;
  frameExec?: ExecFn;
  frameOptions?: FrameExtractOptions;
}

export function createLoopDeps(o: CreateLoopDepsOptions): LoopDeps {
  const cutVideo = o.cutVideo ?? realCutVideo;
  const applyOverlay = o.applyOverlay ?? realApplyOverlay;
  const exec = o.frameExec ?? defaultExec;
  return {
    buildEdl: makeBuildEdl(o.llm),
    render: makeRender(o.library, { cutVideo, applyOverlay }),
    grade: makeGrade(o.llm, { exec, rubric: o.rubric, frameOptions: o.frameOptions }),
    emit: o.emit,
  };
}
