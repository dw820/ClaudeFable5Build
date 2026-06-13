/**
 * Text embeddings via Replicate (OFF the demo path, but fully wired + tested).
 *
 * Used to index clip captions/transcripts for semantic retrieval; the embedding
 * is upserted to pgvector (see pgvector.ts). Embeddings never reach the
 * ClipLibrary contract, so this stays out of `assemble`'s critical path.
 *
 * `parseEmbedding` is PURE (model output → number[]) and separately tested.
 * Replicate embedding models return a few shapes; we accept the common ones:
 *   [0.1, 0.2, ...]                         (bare vector)
 *   [{ embedding: [...] }]                  (per-input objects)
 *   { embedding: [...] } / { vectors: [[...]] }
 */
import type { ReplicateRunner } from "./replicateClient.js";
import { EMBED_MODEL } from "./models.js";

/** PURE: coerce a model response into a single embedding vector. */
export function parseEmbedding(response: unknown): number[] {
  const vec = firstVector(response);
  return vec.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number");
}

function firstVector(response: unknown): number[] {
  if (isNumberArray(response)) return response;

  if (Array.isArray(response) && response.length > 0) {
    const first = response[0];
    if (isNumberArray(first)) return first; // [[...]]
    if (first !== null && typeof first === "object") {
      const e = (first as Record<string, unknown>).embedding;
      if (isNumberArray(e)) return e; // [{ embedding: [...] }]
    }
  }

  if (response !== null && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (isNumberArray(r.embedding)) return r.embedding;
    if (Array.isArray(r.vectors) && isNumberArray(r.vectors[0])) {
      return r.vectors[0] as number[];
    }
  }

  return [];
}

/** Build the embedding request input (extracted for request-construction tests). */
export function embedInput(text: string): object {
  return { text };
}

export interface EmbedOptions {
  text: string;
  model?: `${string}/${string}` | `${string}/${string}:${string}`;
}

/** Embed one piece of text (a clip's caption, typically). */
export async function embedText(
  runner: ReplicateRunner,
  opts: EmbedOptions,
): Promise<number[]> {
  const response = await runner.run(opts.model ?? EMBED_MODEL, {
    input: embedInput(opts.text),
  });
  return parseEmbedding(response);
}
