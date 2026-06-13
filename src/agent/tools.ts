/**
 * The agent's toolset (plan Component 2, Agent SDK migration).
 *
 * Pure: defines the four side-effecting operations as injectable `ToolImpls`
 * (stub now, real ffmpeg/Claude later) plus `createAutocutTools`, which wraps
 * them into SDK-agnostic tool *specs*. The SDK is never imported here — sdk.ts
 * turns these specs into a real MCP server, and tests call the handlers directly.
 */
import { z } from "zod";
import {
  EdlSchema,
  RUBRIC_DIMENSIONS,
  type Clip,
  type ClipLibrary,
  type Edl,
  type Grade,
  type LoopEvent,
  type RenderResult,
} from "../loop/types.js";
import type { Rubric } from "../loop/controller.js";

/** The four operations the agent's tools wrap. Injected: stub now, real later. */
export interface ToolImpls {
  searchClips(query: string, library: ClipLibrary): Promise<Clip[]>;
  /** May return malformed output — the build_edl tool validates with EdlSchema. */
  buildEdl(clipIds: string[], rationale: string, library: ClipLibrary): Promise<unknown>;
  render(edl: Edl): Promise<RenderResult>;
  grade(render: RenderResult, rubric: Rubric): Promise<Grade>;
}

/** Default money-shot script: a weak first cut, then a pass (mirrors loop/stubs). */
const DEFAULT_GRADE_SCRIPT: Grade["scores"][] = [
  { hook_strength: 5, pace_cut_density: 8, caption_legibility: 6, loopability: 7, on_style_trend_fit: 8 },
  { hook_strength: 8, pace_cut_density: 9, caption_legibility: 8, loopability: 8, on_style_trend_fit: 9 },
];

export function makeStubToolImpls(opts: { gradeScript?: Grade["scores"][] } = {}): ToolImpls {
  const script = opts.gradeScript ?? DEFAULT_GRADE_SCRIPT;
  let edlSeq = 0;
  let renderSeq = 0;
  let gradeCalls = 0;

  return {
    async searchClips(_query, library) {
      return library.clips;
    },
    async buildEdl(clipIds, rationale, library) {
      const clip = library.clips.find((c) => clipIds.includes(c.id)) ?? library.clips[0]!;
      edlSeq += 1;
      return {
        edlId: `edl-${edlSeq}`,
        aspect: "9:16",
        targetLenS: 30,
        lut: null,
        segments: [
          {
            clipId: clip.id,
            in: 0,
            out: Math.min(clip.duration, 6),
            transition: "cut",
            captions: [{ text: "wait for the drop", t0: 0, t1: 1.5, style: "bold-center" }],
          },
        ],
        selectionRationale: rationale || `open on ${clip.id}`,
      };
    },
    async render(edl) {
      renderSeq += 1;
      return {
        renderId: `render-${renderSeq}`,
        output: `storage://renders/${edl.edlId}-${renderSeq}.mp4`,
        usedFallback: false,
      };
    },
    async grade(render, rubric) {
      const idx = Math.min(gradeCalls, script.length - 1);
      gradeCalls += 1;
      const scores = script[idx]!;
      const feedback: Record<string, string> = {};
      for (const d of RUBRIC_DIMENSIONS) {
        if (scores[d] < rubric.passThreshold) feedback[d] = `${d} is below ${rubric.passThreshold}`;
      }
      return { renderId: render.renderId, scores, feedback };
    },
  };
}
