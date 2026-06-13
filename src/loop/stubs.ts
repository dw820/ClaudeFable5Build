/**
 * Stub builder / renderer / verifier for build task #1.
 *
 * These let the loop run end-to-end with zero infra so we can prove termination,
 * caps, and best-so-far before the real ffmpeg/Claude/Supabase modules exist.
 * The default grade script encodes the demo's money-shot: a deliberately weak
 * first cut that fails, climbing to a pass — so the controller has something real
 * to self-correct against.
 */
import type { ClipLibrary, Edl, Grade, RenderResult } from "./types.js";
import type { LoopDeps, Rubric } from "./controller.js";

export const VIRAL_RUBRIC: Rubric = { style: "Viral Short", passThreshold: 7 };

/** A tiny valid clip library for tests/demo. */
export const SAMPLE_LIBRARY: ClipLibrary = {
  projectId: "beach-trip",
  clips: [
    {
      id: "c01",
      src: "storage://beach/wipeout.mp4",
      start: 0,
      end: 12,
      duration: 12,
      resolution: [1080, 1920],
      transcript: [{ word: "wait", t0: 0.2, t1: 0.5 }],
      caption: "surfer wipes out on a wave",
      tags: ["action", "hook"],
    },
    {
      id: "c02",
      src: "storage://beach/sunset.mp4",
      start: 0,
      end: 18,
      duration: 18,
      resolution: [1080, 1920],
      transcript: [],
      caption: "golden-hour sunset over the water",
      tags: ["b-roll", "golden-hour"],
    },
  ],
};

/** Scores per iteration (1-indexed). Default: weak first cut → pass on iter 2. */
export const DEFAULT_GRADE_SCRIPT: Grade["scores"][] = [
  { hook_strength: 5, pace_cut_density: 8, caption_legibility: 6, loopability: 7, on_style_trend_fit: 8 },
  { hook_strength: 8, pace_cut_density: 9, caption_legibility: 8, loopability: 8, on_style_trend_fit: 9 },
];

const FEEDBACK_BY_DIM: Record<string, string> = {
  hook_strength: "Hook is a slow pan — lead with the punchline at 0:00",
  caption_legibility: "Captions are small — bump size and add a stroke",
  pace_cut_density: "Mid-section drags — tighten the cuts",
  loopability: "Ending doesn't loop — match the first frame",
  on_style_trend_fit: "Off-trend — align to current Viral Short pacing",
};

function validEdl(iteration: number, library: ClipLibrary): Edl {
  const clip = library.clips[0]!;
  return {
    edlId: `edl-${iteration}`,
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
    selectionRationale: `iteration ${iteration}: open on the hook clip`,
  };
}

export interface StubOptions {
  /** Scores returned per iteration. Defaults to DEFAULT_GRADE_SCRIPT. */
  gradeScript?: Grade["scores"][];
  /** If set, render() throws on these (1-indexed) iterations. */
  failRenderOn?: number[];
  /** If set, buildEdl() returns schema-invalid output on these iterations. */
  invalidEdlOn?: number[];
  /** If true, render reports the ffmpeg-caption fallback was used. */
  alwaysFallback?: boolean;
  emit?: LoopDeps["emit"];
  now?: LoopDeps["now"];
  spentTokens?: LoopDeps["spentTokens"];
  /** Artificial delay (ms) per build/render/grade so a live demo run unfolds
   *  visibly instead of all at once. Defaults to 0 (instant — tests unaffected). */
  delayMs?: number;
}

const wait = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Build a set of injected deps for the loop controller. */
export function makeStubDeps(opts: StubOptions = {}): LoopDeps {
  const script = opts.gradeScript ?? DEFAULT_GRADE_SCRIPT;
  const delay = opts.delayMs ?? 0;
  let buildCalls = 0;
  let gradeCalls = 0;

  return {
    buildEdl: async (ctx) => {
      await wait(delay);
      buildCalls += 1;
      if (opts.invalidEdlOn?.includes(ctx.iteration)) {
        return { edlId: "bad", segments: [] }; // fails EdlSchema (no aspect, empty segments)
      }
      return validEdl(ctx.iteration, ctx.library);
    },
    render: async (edl: Edl): Promise<RenderResult> => {
      await wait(delay);
      const iter = Number(edl.edlId.replace("edl-", "")) || buildCalls;
      if (opts.failRenderOn?.includes(iter)) {
        throw new Error(`ffmpeg exited non-zero on iteration ${iter}`);
      }
      return {
        renderId: `render-${iter}`,
        output: `storage://renders/render-${iter}.mp4`,
        usedFallback: opts.alwaysFallback ?? false,
      };
    },
    grade: async (render: RenderResult, rubric: Rubric): Promise<Grade> => {
      await wait(delay);
      const idx = Math.min(gradeCalls, script.length - 1);
      gradeCalls += 1;
      const scores = script[idx]!;
      const feedback: Record<string, string> = {};
      for (const [dim, score] of Object.entries(scores)) {
        if (score < rubric.passThreshold && FEEDBACK_BY_DIM[dim]) {
          feedback[dim] = FEEDBACK_BY_DIM[dim]!;
        }
      }
      return { renderId: render.renderId, scores, feedback };
    },
    emit: opts.emit,
    now: opts.now,
    spentTokens: opts.spentTokens,
  };
}
