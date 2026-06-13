/**
 * Assemble per-clip model results into a validated ClipLibrary, then write
 * clips.json. This is the join point of the offline preprocess pipeline.
 *
 *  PREPROCESS PIPELINE (offline producer of clips.json — NOT a LoopDep)
 *  ───────────────────────────────────────────────────────────────────
 *
 *   media/ dir
 *      │   (cli.ts walks files)
 *      ▼
 *   ┌──────────────┐   ffmpeg frames   ┌────────────────────┐
 *   │  clip file   │ ────────────────▶ │ frameUnderstand.ts │── caption + tags ─┐
 *   │ (.mp4 etc.)  │                   │   (VLM via Replicate)                  │
 *   └──────┬───────┘                   └────────────────────┘                   │
 *          │  audio                    ┌────────────────────┐                   ▼
 *          ├─────────────────────────▶ │   transcribe.ts    │── TranscriptWord[]┤
 *          │   (whisper via Replicate) └────────────────────┘                   │
 *          │  ffprobe                  ┌────────────────────┐                    │
 *          └─────────────────────────▶ │   probe (duration, │── start/end/res ──┤
 *                                       │   resolution)      │                   │
 *                                       └────────────────────┘                   │
 *                                                                                ▼
 *   caption ───────────────────────────┐                              ┌──────────────────┐
 *   (off-path) embed.ts ── number[] ──▶ │ pgvector.ts (Supabase upsert)│   assemble.ts    │
 *                                       └──────────────────────────────┤  buildClip()     │
 *                                                                       │  assembleLibrary │
 *                                                                       │  ClipLibrarySchema.parse
 *                                                                       │  writeClipsJson  │
 *                                                                       └────────┬─────────┘
 *                                                                                ▼
 *                                                                          clips.json
 *                                                            (local src paths under MEDIA_DIR;
 *                                                             consumed by edit/ + verify/)
 */
import { writeFile } from "node:fs/promises";
import type { z } from "zod";
import {
  ClipLibrarySchema,
  type Clip,
  type ClipLibrary,
  type Scene,
  type TranscriptWordSchema,
} from "../loop/types.js";

/** Derived from the frozen schema (types.ts exports the schema, not the type). */
type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

/** What a clip's container reports — supplied by an injected probe (ffprobe). */
export interface ClipMeta {
  durationS: number;
  width: number;
  height: number;
}

/** Per-clip inputs gathered by the three pipeline steps, ready to combine. */
export interface ClipParts {
  /** Stable id (e.g. derived from filename). */
  id: string;
  /** Local path stored verbatim in clip.src (relative to MEDIA_DIR). */
  src: string;
  meta: ClipMeta;
  transcript: TranscriptWord[];
  caption: string;
  tags: string[];
  /** Per-scene captions from understandScenes; absent/empty for single-scene clips. */
  scenes?: Scene[];
}

/** Caption of the scene covering the clip's temporal midpoint (deterministic). */
function captionAtMidpoint(scenes: Scene[], durationS: number): string {
  const mid = durationS / 2;
  const hit = scenes.find((s) => mid >= s.t0 && mid < s.t1) ?? scenes[0];
  return hit ? hit.caption : "";
}

/** De-duped union of all scene tags, order-preserved, capped. */
function unionTags(scenes: Scene[], max = 8): string[] {
  const seen = new Set<string>();
  for (const s of scenes) for (const t of s.tags) if (t !== "") seen.add(t);
  return [...seen].slice(0, max);
}

/**
 * Combine one clip's parts into a Clip. The whole source clip is one
 * selectable unit for the demo, so start=0 and end=duration. A non-positive
 * duration is a probe failure, not a valid clip — fail loud.
 */
export function buildClip(parts: ClipParts): Clip {
  const duration = parts.meta.durationS;
  if (!(duration > 0)) {
    throw new Error(`clip "${parts.id}" has non-positive duration ${duration}`);
  }
  const scenes = parts.scenes ?? [];
  const hasScenes = scenes.length > 0;
  return {
    id: parts.id,
    src: parts.src,
    start: 0,
    end: duration,
    duration,
    resolution: [parts.meta.width, parts.meta.height],
    transcript: parts.transcript,
    caption: hasScenes ? captionAtMidpoint(scenes, duration) : parts.caption,
    tags: hasScenes ? unionTags(scenes) : parts.tags,
    ...(hasScenes ? { scenes } : {}),
  };
}

/**
 * Build + validate a ClipLibrary from per-clip parts. Validation is the gate:
 * a malformed clip (e.g. a zero dimension, an out-of-spec transcript) is caught
 * here via ClipLibrarySchema, not three modules downstream in edit/.
 */
export function assembleLibrary(
  projectId: string,
  parts: ClipParts[],
): ClipLibrary {
  const clips = parts.map(buildClip);
  return ClipLibrarySchema.parse({ projectId, clips });
}

/** Serialize a validated library to clips.json (pretty, newline-terminated). */
export async function writeClipsJson(
  library: ClipLibrary,
  outPath: string,
): Promise<void> {
  await writeFile(outPath, JSON.stringify(library, null, 2) + "\n", "utf8");
}
