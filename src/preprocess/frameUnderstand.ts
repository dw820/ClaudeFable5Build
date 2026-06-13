/**
 * Frame understanding: sample frames with ffmpeg, send to a Replicate VLM,
 * and derive a one-line caption + a small set of content tags per clip.
 *
 * Two injectable seams keep this unit-testable with no ffmpeg and no network:
 *   - frame access via an injected `exec` (`sampleFrameAt`) or a `FrameSampler`;
 *     tests pass fakes that return canned bytes/refs.
 *   - `ReplicateRunner` — the VLM call.
 *
 * Production now captions PER SCENE: `cli.ts` calls `understandScenes` (one
 * midpoint frame per scene window from `scenes.ts`). `understandFrames` /
 * `ffmpegFrameSampler` remain for the single-frame path and the unit tests.
 *
 * `parseVlmResponse` is PURE (VLM output → { caption, tags }) and separately
 * tested. The VLM is prompted to emit JSON; we also tolerate loose prose so a
 * non-conforming model still yields a usable caption.
 */
import type { ReplicateRunner } from "./replicateClient.js";
import { VLM_MODEL } from "./models.js";
import type { Scene } from "../loop/types.js";

export interface FrameUnderstanding {
  caption: string;
  tags: string[];
}

/** Injected command runner so the ffmpeg call is mockable / swappable. */
export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Returns frame references (URLs or data URIs) the VLM can consume. */
export interface FrameSampler {
  sample(clipPath: string, count: number): Promise<string[]>;
}

/** Strip code fences / surrounding prose to find the first JSON object. */
function extractJsonObject(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Normalize tags: lowercase, trim, de-dupe, drop empties, cap the count. */
function normalizeTags(raw: unknown, max = 8): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const t of list) {
    const tag = String(t).trim().toLowerCase();
    if (tag !== "" && !seen.has(tag)) seen.add(tag);
  }
  return [...seen].slice(0, max);
}

/**
 * Replicate may return a VLM answer as a string or as a string[] of tokens
 * (LLaVA-style streaming joined). Collapse to one string.
 */
function flattenOutput(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map((x) => String(x)).join("");
  if (response !== null && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.output === "string") return r.output;
    if (Array.isArray(r.output)) return r.output.map((x) => String(x)).join("");
  }
  return "";
}

/**
 * PURE: VLM response → { caption, tags }. Accepts strict JSON
 * `{ caption, tags }`, or falls back to treating the whole text as the caption
 * with no tags. Never throws.
 */
export function parseVlmResponse(response: unknown): FrameUnderstanding {
  const text = flattenOutput(response).trim();
  const obj = extractJsonObject(text);
  if (obj !== undefined && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const caption =
      typeof o.caption === "string" ? o.caption.trim() : text.replace(/\s+/g, " ");
    return { caption, tags: normalizeTags(o.tags) };
  }
  // No JSON — use the prose as the caption, collapse whitespace.
  return { caption: text.replace(/\s+/g, " "), tags: [] };
}

/** The instruction we send the VLM. Extracted so the test can assert it. */
export const VLM_PROMPT =
  'Describe this video clip in one vivid sentence for a video editor, then list 3-6 short content tags. ' +
  'Respond as strict JSON: {"caption": "...", "tags": ["...", "..."]}.';

/** Build the VLM request input (extracted for request-construction tests). */
export function vlmInput(frameRef: string): object {
  return { image: frameRef, prompt: VLM_PROMPT };
}

/**
 * ffmpeg-backed frame sampler. Extracts `count` evenly-spaced JPEG frames as
 * base64 data URIs. The exec is injected so this is testable / swappable.
 *
 * Uses `-vf fps` with a single `-frames:v` cap is awkward for even spacing, so
 * we let the caller-provided exec return whatever the command produces; here we
 * request frames to stdout as image2pipe and split on JPEG SOI markers.
 */
export function ffmpegFrameSampler(exec: ExecFn): FrameSampler {
  return {
    async sample(clipPath: string, count: number): Promise<string[]> {
      // Emit `count` evenly distributed frames to stdout as a raw MJPEG stream.
      const { stdout } = await exec("ffmpeg", [
        "-i",
        clipPath,
        "-vf",
        `thumbnail,fps=1/2`,
        "-frames:v",
        String(count),
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ]);
      // stdout is binary-as-latin1 from the injected exec; split on JPEG SOI.
      const buf = Buffer.from(stdout, "binary");
      const frames = splitJpegs(buf).slice(0, count);
      return frames.map(
        (f) => `data:image/jpeg;base64,${f.toString("base64")}`,
      );
    },
  };
}

/** Split a concatenated MJPEG byte stream into individual JPEG frames. */
function splitJpegs(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) start = i; // SOI
    if (buf[i] === 0xff && buf[i + 1] === 0xd9 && start !== -1) {
      frames.push(buf.subarray(start, i + 2)); // include EOI
      start = -1;
    }
  }
  return frames;
}

export interface FrameUnderstandOptions {
  clipPath: string;
  frameCount?: number;
  model?: `${string}/${string}` | `${string}/${string}:${string}`;
}

/**
 * Sample frames and ask the VLM for a caption + tags. We caption from a single
 * representative (middle) frame to keep the demo cheap; the sampler still pulls
 * several so callers can extend to multi-frame fusion later.
 */
export async function understandFrames(
  runner: ReplicateRunner,
  sampler: FrameSampler,
  opts: FrameUnderstandOptions,
): Promise<FrameUnderstanding> {
  const count = opts.frameCount ?? 3;
  const frames = await sampler.sample(opts.clipPath, count);
  if (frames.length === 0) {
    return { caption: "", tags: [] };
  }
  const representative = frames[Math.floor(frames.length / 2)] ?? frames[0]!;
  const response = await runner.run(opts.model ?? VLM_MODEL, {
    input: vlmInput(representative),
  });
  return parseVlmResponse(response);
}

/**
 * Extract a single JPEG frame at a precise timestamp as a base64 data URI.
 * `-ss` before `-i` is a fast keyframe-accurate seek; `-frames:v 1` takes one
 * frame. Reuses the same MJPEG-split path as the sampler.
 */
export async function sampleFrameAt(exec: ExecFn, clipPath: string, atS: number): Promise<string | null> {
  const { stdout } = await exec("ffmpeg", [
    "-ss", String(atS),
    "-i", clipPath,
    "-frames:v", "1",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ]);
  const buf = Buffer.from(stdout, "binary");
  const [frame] = splitJpegs(buf);
  return frame ? `data:image/jpeg;base64,${frame.toString("base64")}` : null;
}

/**
 * Extract a single downscaled JPEG poster frame at `atS` seconds, as raw bytes
 * ready to upload to Storage. Separate from `sampleFrameAt` (which returns a
 * full-res data URI for the VLM): posters are scaled to 420px wide to keep the
 * setup-screen grid light. Returns null when ffmpeg emits no frame (e.g. seek
 * past the end of a very short clip).
 */
export async function extractPosterJpeg(
  exec: ExecFn,
  clipPath: string,
  atS: number,
): Promise<Uint8Array | null> {
  const { stdout } = await exec("ffmpeg", [
    "-ss", String(atS),
    "-i", clipPath,
    "-frames:v", "1",
    "-vf", "scale=420:-1",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ]);
  const buf = Buffer.from(stdout, "binary");
  const [frame] = splitJpegs(buf);
  return frame ? new Uint8Array(frame) : null;
}

/**
 * Caption each scene window from its midpoint frame. Sequential so test runners
 * with call-indexed fakes are deterministic; the per-clip fan-out in cli.ts
 * already runs clips in parallel. A failed frame/VLM call degrades that one
 * scene to an empty caption rather than failing the whole clip.
 */
export async function understandScenes(
  runner: ReplicateRunner,
  exec: ExecFn,
  clipPath: string,
  windows: { t0: number; t1: number }[],
  opts: { model?: `${string}/${string}` | `${string}/${string}:${string}` } = {},
): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const w of windows) {
    try {
      const frame = await sampleFrameAt(exec, clipPath, (w.t0 + w.t1) / 2);
      if (!frame) {
        scenes.push({ t0: w.t0, t1: w.t1, caption: "", tags: [] });
        continue;
      }
      const response = await runner.run(opts.model ?? VLM_MODEL, { input: vlmInput(frame) });
      const { caption, tags } = parseVlmResponse(response);
      scenes.push({ t0: w.t0, t1: w.t1, caption, tags });
    } catch {
      scenes.push({ t0: w.t0, t1: w.t1, caption: "", tags: [] });
    }
  }
  return scenes;
}
