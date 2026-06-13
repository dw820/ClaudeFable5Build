/**
 * Real tool implementations for the autonomous agent (Phase 3, increment 1).
 *
 * Bridges the existing real modules — makeBuildEdl (LLM), makeRender (ffmpeg),
 * makeGrade (ffmpeg + Claude vision) — into the agent's ToolImpls shape. search
 * stays a stub (returns the library's clips). Every inner impl is injectable so
 * the bridges unit-test offline; production passes the real defaults.
 *
 * Captions use the ffmpeg drawtext fallback: applyOverlay is called with a
 * renderRemotion that rejects, so Remotion is never invoked (deferred).
 */
import type { ClipLibrary, Edl, Grade, RenderResult } from "../loop/types.js";
import type { BuildContext, Rubric } from "../loop/controller.js";
import type { LlmClient } from "../llm/client.js";
import type { ExecFn } from "../verify/frames.js";
import type { ToolImpls } from "./tools.js";
import { makeBuildEdl } from "../builder/build.js";
import { makeRender } from "../render/render.js";
import { makeGrade } from "../verify/grade.js";
import { cutVideo as realCutVideo } from "../edit/cut.js";
import { applyOverlay as realApplyOverlay, defaultFfmpegExec } from "../overlay/overlay.js";
import { defaultExec } from "../loop/deps.js";

export interface RealToolDeps {
  llm: LlmClient;
  /** The fixture library — also the render source (clip.src resolved vs MEDIA_DIR). */
  library: ClipLibrary;
  /** Per-run brief, closed over for the buildEdl BuildContext. */
  brief: string;
  rubric: Rubric;
  /** ffmpeg/ffprobe runner for keyframe extraction. Defaults to the real spawner. */
  exec?: ExecFn;
  /** Inner impls — default to the real factories; overridden in offline tests. */
  buildEdl?: (ctx: BuildContext) => Promise<unknown>;
  render?: (edl: Edl) => Promise<RenderResult>;
  grade?: (render: RenderResult, rubric: Rubric) => Promise<Grade>;
}

export function makeRealToolImpls(deps: RealToolDeps): ToolImpls {
  // Force the ffmpeg drawtext caption path: reject Remotion so applyOverlay
  // always falls back (usedFallback: true). Remotion is deferred this increment.
  const ffmpegOnlyOverlay = (basePath: string, edl: Edl) =>
    realApplyOverlay(basePath, edl, {
      renderRemotion: () => Promise.reject(new Error("Remotion deferred (Phase 3 increment 1)")),
      runFfmpeg: defaultFfmpegExec,
    });

  const buildEdlFn = deps.buildEdl ?? makeBuildEdl(deps.llm);
  const renderFn =
    deps.render ?? makeRender(deps.library, { cutVideo: realCutVideo, applyOverlay: ffmpegOnlyOverlay });
  const gradeFn = deps.grade ?? makeGrade(deps.llm, { exec: deps.exec ?? defaultExec });

  let iteration = 0;

  return {
    async searchClips(_query, library) {
      return library.clips;
    },
    async buildEdl(clipIds, rationale, library) {
      iteration += 1;
      const scoped =
        clipIds.length > 0
          ? { ...library, clips: library.clips.filter((c) => clipIds.includes(c.id)) }
          : library;
      // If the selection matched nothing in the library, fall back to the full set.
      const forBuild = scoped.clips.length > 0 ? scoped : library;
      const brief = rationale ? `${deps.brief}\n\nEditor's note: ${rationale}` : deps.brief;
      const ctx: BuildContext = { brief, rubric: deps.rubric, library: forBuild, iteration };
      return buildEdlFn(ctx);
    },
    render(edl) {
      return renderFn(edl);
    },
    grade(render, rubric) {
      return gradeFn(render, rubric);
    },
  };
}
