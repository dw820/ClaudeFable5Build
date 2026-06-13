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

/** An SDK-agnostic tool spec. sdk.ts turns these into real SDK tools. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
}

export interface AutocutToolsDeps {
  impls: ToolImpls;
  library: ClipLibrary;
  rubric: Rubric;
  tracker: import("./tracker.js").Tracker;
  emit: (e: Omit<LoopEvent, "ts">) => void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** One-decimal second formatter for scene timecodes. */
const fmtS = (n: number): string => n.toFixed(1);

/** `id: caption [tags]`, plus indented timed scene lines when the clip has scenes. */
function formatClipLine(c: Clip): string {
  const base = `${c.id}: ${c.caption} [${c.tags.join(", ")}]`;
  if (!c.scenes || c.scenes.length <= 1) return base;
  const scenes = c.scenes
    .map((s) => `\n    ${fmtS(s.t0)}–${fmtS(s.t1)}s: ${s.caption}`)
    .join("");
  return base + scenes;
}

/** Transcript words whose midpoint falls in [t0, t1), joined into a quote. */
function transcriptForWindow(words: Clip["transcript"], t0: number, t1: number): string {
  return words
    .filter((w) => {
      const mid = (w.t0 + w.t1) / 2;
      return mid >= t0 && mid < t1;
    })
    .map((w) => w.word)
    .join(" ");
}

/**
 * The full per-clip view the agent needs before choosing in/out points:
 * dimensions, the scene-by-scene breakdown, and the transcript aligned to each
 * scene window. With no scenes it falls back to the whole-clip transcript; with
 * no transcript it says so rather than emitting an empty quote.
 */
export function formatClipInspection(c: Clip): string {
  const [w, h] = c.resolution;
  const head = `${c.id} — ${c.caption} [${c.tags.join(", ")}]\nduration: ${fmtS(c.duration)}s  resolution: ${w}x${h}`;
  if (c.scenes && c.scenes.length > 0) {
    const lines = c.scenes.map((s) => {
      const tagStr = s.tags.length ? ` [${s.tags.join(", ")}]` : "";
      const quote = transcriptForWindow(c.transcript, s.t0, s.t1);
      const body = quote ? `      "${quote}"` : "      (no transcript)";
      return `    ${fmtS(s.t0)}–${fmtS(s.t1)}s: ${s.caption}${tagStr}\n${body}`;
    });
    return `${head}\nscenes:\n${lines.join("\n")}`;
  }
  const all = c.transcript.map((x) => x.word).join(" ");
  return `${head}\ntranscript: ${all || "(no transcript)"}`;
}

/**
 * Build the five tool specs, wired to the injected impls, the tracker (best-so-far),
 * and the event sink. `iteration` increments on each build_edl — the agent's
 * self-correction rounds, surfaced to the UI exactly like the loop's iterations.
 */
export function createAutocutTools(deps: AutocutToolsDeps): { specs: ToolSpec[]; allowedTools: string[] } {
  const { impls, library, rubric, tracker, emit } = deps;
  const edls = new Map<string, Edl>();
  const renders = new Map<string, RenderResult>();
  let iteration = 0;

  const specs: ToolSpec[] = [
    {
      name: "search_clips",
      description: "Search the clip library. Returns id, caption, and tags for each candidate clip.",
      schema: { query: z.string() },
      handler: async (args) => {
        const clips = await impls.searchClips(String(args.query ?? ""), library);
        emit({ iteration, phase: "select", message: `search_clips → ${clips.length} candidates` });
        return text(clips.map((c) => formatClipLine(c)).join("\n"));
      },
    },
    {
      name: "inspect_clip",
      description:
        "Inspect one clip in depth: duration, resolution, its scene-by-scene breakdown, " +
        "and the transcript aligned to each scene. Use this before choosing in/out timestamps " +
        "for a clip whose captions or tags are not specific enough to cut from confidently.",
      schema: { clipId: z.string() },
      handler: async (args) => {
        const clip = library.clips.find((c) => c.id === String(args.clipId));
        if (!clip) {
          return text(`UNKNOWN_CLIP: ${args.clipId}. Call search_clips to list available clip ids.`);
        }
        emit({ iteration, phase: "select", message: `inspect_clip ${clip.id}` });
        return text(formatClipInspection(clip));
      },
    },
    {
      name: "build_edl",
      description: "Compose an Edit Decision List from clip ids. Returns edlId, or INVALID_EDL to fix.",
      schema: { clipIds: z.array(z.string()), rationale: z.string().optional() },
      handler: async (args) => {
        iteration += 1;
        const clipIds = (args.clipIds as string[]) ?? [];
        emit({ iteration, phase: "build", message: `build_edl from [${clipIds.join(", ")}]` });
        const raw = await impls.buildEdl(clipIds, String(args.rationale ?? ""), library);
        const parsed = EdlSchema.safeParse(raw);
        if (!parsed.success) {
          const why = parsed.error.issues[0]?.message ?? "schema error";
          emit({ iteration, phase: "fix", message: `EDL invalid: ${why}` });
          return text(`INVALID_EDL: ${why}. Adjust clip selection/structure and call build_edl again.`);
        }
        edls.set(parsed.data.edlId, parsed.data);
        return text(`edlId=${parsed.data.edlId} (validated, ${parsed.data.segments.length} segment(s))`);
      },
    },
    {
      name: "render",
      description: "Render a built EDL to a video. Returns renderId and output ref.",
      schema: { edlId: z.string() },
      handler: async (args) => {
        const edl = edls.get(String(args.edlId));
        if (!edl) return text(`UNKNOWN_EDL: ${args.edlId}. Call build_edl first.`);
        const r = await impls.render(edl);
        renders.set(r.renderId, r);
        emit({
          iteration,
          phase: "render",
          message: `render ${r.renderId}${r.usedFallback ? " (fallback overlay)" : ""}`,
          renderRef: r.output,
        });
        return text(`renderId=${r.renderId} output=${r.output}`);
      },
    },
    {
      name: "grade",
      description: "Grade a render against the rubric. You MUST grade every render before publishing.",
      schema: { renderId: z.string() },
      handler: async (args) => {
        const r = renders.get(String(args.renderId));
        if (!r) return text(`UNKNOWN_RENDER: ${args.renderId}. Call render first.`);
        const g = await impls.grade(r, rubric);
        tracker.record(r, g, iteration);
        const passedCount = RUBRIC_DIMENSIONS.filter((d) => g.scores[d] >= rubric.passThreshold).length;
        emit({
          iteration,
          phase: "grade",
          message: `grade ${r.renderId}: ${passedCount}/${RUBRIC_DIMENSIONS.length} dims pass`,
          scores: g.scores,
          renderRef: r.output,
        });
        const fb = Object.entries(g.feedback).map(([d, n]) => `- ${d}: ${n}`).join("\n");
        const verdict =
          passedCount === RUBRIC_DIMENSIONS.length
            ? "PASS — every dimension meets the threshold. Call publish."
            : `NOT YET — ${passedCount}/${RUBRIC_DIMENSIONS.length} dimensions pass. Improve the EDL and re-render.`;
        return text(`${verdict}\nscores=${JSON.stringify(g.scores)}${fb ? `\n${fb}` : ""}`);
      },
    },
    {
      name: "publish",
      description: "Ship a render as the final cut. Call only after a grade you are satisfied with.",
      schema: { renderId: z.string() },
      handler: async (args) => {
        const r = renders.get(String(args.renderId));
        if (!r) return text(`UNKNOWN_RENDER: ${args.renderId}.`);
        tracker.publish(r.renderId);
        emit({ iteration, phase: "ship", message: `agent published ${r.renderId}`, renderRef: r.output });
        return text(`PUBLISHED ${r.renderId}. You are done.`);
      },
    },
  ];

  const allowedTools = specs.map((s) => `mcp__autocut__${s.name}`);
  return { specs, allowedTools };
}
