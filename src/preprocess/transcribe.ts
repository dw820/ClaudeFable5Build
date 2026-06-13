/**
 * Word-level transcription via a Replicate whisper model.
 *
 * Split in two so the network-free part is unit-testable:
 *   - `parseWhisperWords` — PURE: whisper response → TranscriptWord[].
 *   - `transcribeClip`    — injects a ReplicateRunner, builds the request,
 *                           and maps the response through the pure parser.
 *
 * Whisper output shape varies by model build; we accept the common variants:
 *   { chunks:   [{ text, timestamp: [t0, t1] }, ...] }   (HF whisper)
 *   { segments: [{ words: [{ word, start, end }, ...] }, ...] }
 *   { words:    [{ word, start, end }, ...] }
 * A clip with no speech yields `[]` (the shadow/empty-transcript path that
 * assemble.ts must tolerate — see sample-clips.json c02).
 */
import type { z } from "zod";
import type { TranscriptWordSchema } from "../loop/types.js";
import type { ReplicateRunner } from "./replicateClient.js";

/** Derived from the frozen schema (types.ts exports the schema, not the type). */
type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
import { WHISPER_MODEL } from "./models.js";

/** Coerce a value to a finite, non-negative number or `undefined`. */
function toTime(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function pushWord(
  out: TranscriptWord[],
  word: unknown,
  t0: unknown,
  t1: unknown,
): void {
  const text = typeof word === "string" ? word.trim() : "";
  const a = toTime(t0);
  const b = toTime(t1);
  if (text === "" || a === undefined || b === undefined) return;
  // Guard against models that emit t1 < t0 (clamp to a zero-length token).
  out.push({ word: text, t0: a, t1: Math.max(a, b) });
}

/**
 * PURE: normalize a whisper response into word-level transcript tokens.
 * Unknown / empty shapes return `[]` rather than throwing — a silent clip is a
 * valid clip, not an error.
 */
export function parseWhisperWords(response: unknown): TranscriptWord[] {
  if (response === null || typeof response !== "object") return [];
  const r = response as Record<string, unknown>;
  const out: TranscriptWord[] = [];

  // Variant A: flat word list with start/end.
  if (Array.isArray(r.words)) {
    for (const w of r.words as Array<Record<string, unknown>>) {
      pushWord(out, w.word ?? w.text, w.start ?? w.t0, w.end ?? w.t1);
    }
    if (out.length > 0) return out;
  }

  // Variant B: segments, each with a nested words[] (preferred) or a span.
  if (Array.isArray(r.segments)) {
    for (const seg of r.segments as Array<Record<string, unknown>>) {
      if (Array.isArray(seg.words)) {
        for (const w of seg.words as Array<Record<string, unknown>>) {
          pushWord(out, w.word ?? w.text, w.start ?? w.t0, w.end ?? w.t1);
        }
      }
    }
    if (out.length > 0) return out;
  }

  // Variant C: HF "chunks" with [t0, t1] timestamp tuples.
  if (Array.isArray(r.chunks)) {
    for (const c of r.chunks as Array<Record<string, unknown>>) {
      const ts = c.timestamp;
      if (Array.isArray(ts) && ts.length === 2) {
        pushWord(out, c.text, ts[0], ts[1]);
      }
    }
  }

  return out;
}

export interface TranscribeOptions {
  /** Replicate-accessible URL or file ref for the clip's audio/video. */
  audio: string;
  model?: `${string}/${string}` | `${string}/${string}:${string}`;
}

/** Build the whisper request input (extracted so the test can assert it). */
export function whisperInput(audio: string): object {
  return {
    audio,
    // Ask for word-level timestamps regardless of model build naming.
    language: "auto",
    timestamp: "word",
    word_timestamps: true,
  };
}

/** Run whisper for one clip and map to word-level transcript. */
export async function transcribeClip(
  runner: ReplicateRunner,
  opts: TranscribeOptions,
): Promise<TranscriptWord[]> {
  const response = await runner.run(opts.model ?? WHISPER_MODEL, {
    input: whisperInput(opts.audio),
  });
  return parseWhisperWords(response);
}
