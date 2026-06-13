/**
 * AutoCut data contracts (PRD §0b).
 *
 * The agent never touches ffmpeg directly: the builder emits a schema-validated
 * EDL, a deterministic renderer compiles it, and an independent verifier returns
 * a structured grade. These zod schemas are the single source of truth for those
 * boundaries, so a malformed model output is caught here, not three modules later.
 */
import { z } from "zod";

/* ---------- clips.json (produced offline by preprocess/) ---------- */

export const TranscriptWordSchema = z.object({
  word: z.string(),
  t0: z.number().nonnegative(),
  t1: z.number().nonnegative(),
});

export const ClipSchema = z.object({
  id: z.string(),
  src: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  duration: z.number().positive(),
  resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  transcript: z.array(TranscriptWordSchema),
  caption: z.string(),
  tags: z.array(z.string()),
});
export type Clip = z.infer<typeof ClipSchema>;

export const ClipLibrarySchema = z.object({
  projectId: z.string(),
  clips: z.array(ClipSchema).min(1),
});
export type ClipLibrary = z.infer<typeof ClipLibrarySchema>;

/* ---------- EDL (builder output) ---------- */

export const TRANSITIONS = ["cut", "crossfade"] as const;

export const CaptionSchema = z.object({
  text: z.string().min(1),
  t0: z.number().nonnegative(),
  t1: z.number().nonnegative(),
  style: z.string().default("bold-center"),
});

export const SegmentSchema = z.object({
  clipId: z.string(),
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  transition: z.enum(TRANSITIONS),
  captions: z.array(CaptionSchema).default([]),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const EdlSchema = z.object({
  edlId: z.string(),
  aspect: z.enum(["9:16", "1:1", "16:9"]),
  targetLenS: z.number().positive(),
  lut: z.string().nullable().default(null),
  segments: z.array(SegmentSchema).min(1),
  selectionRationale: z.string().default(""),
});
export type Edl = z.infer<typeof EdlSchema>;

/* ---------- rubric + grade (verifier output) ---------- */

/** Viral Short rubric dimensions. Pass = every dimension >= passThreshold. */
export const RUBRIC_DIMENSIONS = [
  "hook_strength",
  "pace_cut_density",
  "caption_legibility",
  "loopability",
  "on_style_trend_fit",
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

const ScoreSchema = z.number().min(0).max(10);

export const GradeSchema = z.object({
  renderId: z.string(),
  scores: z.object({
    hook_strength: ScoreSchema,
    pace_cut_density: ScoreSchema,
    caption_legibility: ScoreSchema,
    loopability: ScoreSchema,
    on_style_trend_fit: ScoreSchema,
  }),
  /** Per-failing-dimension actionable feedback, keyed by dimension. */
  feedback: z.record(z.string()).default({}),
});
export type Grade = z.infer<typeof GradeSchema>;

/* ---------- render result ---------- */

export interface RenderResult {
  renderId: string;
  /** Path/ref to the rendered file (Storage ref in production). */
  output: string;
  /** True when Remotion overlay failed and the ffmpeg-caption fallback was used. */
  usedFallback: boolean;
}

/* ---------- loop events (written to Supabase, streamed to UI) ---------- */

export type LoopPhase =
  | "plan"
  | "select"
  | "build"
  | "render"
  | "grade"
  | "fix"
  | "ship"
  | "memory";

export interface LoopEvent {
  iteration: number;
  phase: LoopPhase;
  message: string;
  /** Present on grade events: the dimension scores snapshot for the scorecard. */
  scores?: Grade["scores"];
  renderRef?: string;
  ts: number;
}
