/**
 * EDL builder factory (Lane D) — turns clips.json into an EDL via the LLM.
 *
 * The `LlmClient` is INJECTED (production: AnthropicClient on claude-opus-4-8;
 * tests: FakeLlmClient), so this module constructs no client and needs no API
 * key at import time. `makeBuildEdl` returns a function with exactly the
 * `LoopDeps.buildEdl` signature; the controller validates the result against
 * `EdlSchema`, so returning `unknown` (a best-effort parsed object) is correct —
 * we do not throw on minor issues, we let the loop bounce a truly-invalid EDL.
 *
 *   ┌──────────────┐   buildPrompt    ┌───────────┐   llm.complete   ┌──────────┐
 *   │ BuildContext │ ───────────────▶ │  prompt   │ ───────────────▶ │  model   │
 *   │ brief+rubric │                  │ {sys,usr} │                  │  JSON    │
 *   │ +library     │                  └───────────┘                  └────┬─────┘
 *   └──────────────┘                                                      │
 *                                                                         ▼
 *                          ┌──────────────────────────────────┐    parse JSON
 *                          │ POST-FILTER:                      │ ◀──────────────
 *   returned EDL  ◀─────────│  • drop segments clipId ∉ library │
 *   (unknown → controller   │  • nudge out-points → targetLenS  │
 *    validates via schema)  │    using edlDurationS             │
 *                          └──────────────────────────────────┘
 */
import type { LlmClient } from "../llm/client.js";
import type { BuildContext } from "../loop/controller.js";
import {
  EdlSchema,
  type ClipLibrary,
  type Edl,
  type Segment,
} from "../loop/types.js";
import { TARGET_LEN_TOLERANCE_S, edlDurationS } from "../constants.js";
import { buildPrompt } from "./prompt.js";

/** Output tokens to allow for the EDL JSON — generous, EDLs are small. */
const MAX_TOKENS = 2048;

/**
 * Parse the model's text response into a JSON object. Tolerates a single
 * ```json fenced block or surrounding prose by extracting the outermost
 * `{...}`; returns `undefined` when nothing parseable is found (the controller
 * then bounces the build).
 */
function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(trimmed.slice(start, end + 1));
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Set of clip ids present in the library, for membership checks. */
function clipIdSet(library: ClipLibrary): Set<string> {
  return new Set(library.clips.map((c) => c.id));
}

/** Max valid out-point for a segment, bounded by its source clip's duration. */
function clipDuration(library: ClipLibrary, clipId: string): number | undefined {
  return library.clips.find((c) => c.id === clipId)?.duration;
}

/**
 * Drop segments whose clipId is not in the library. Returns the surviving
 * segments unchanged (out-point nudging happens separately).
 */
function dropUnknownClips(segments: Segment[], ids: Set<string>): Segment[] {
  return segments.filter((s) => ids.has(s.clipId));
}

/**
 * Nudge segment out-points so total duration moves toward targetLenS. Uses the
 * shared `edlDurationS` so the builder's length math agrees with the renderer's.
 *   - too long:  trim out-points from the LAST segment inward.
 *   - too short: extend out-points toward each clip's duration ceiling.
 * Never produces an out <= in or out > clip duration. Best-effort: if it can't
 * reach tolerance it returns the closest it managed.
 */
function nudgeToTarget(edl: Edl, library: ClipLibrary): Edl {
  if (Math.abs(edlDurationS(edl) - edl.targetLenS) <= TARGET_LEN_TOLERANCE_S) {
    return edl;
  }

  const segments = edl.segments.map((s) => ({ ...s }));

  // Too long: trim from the last segment backward.
  for (let i = segments.length - 1; i >= 0; i--) {
    const over = edlDurationS({ ...edl, segments }) - edl.targetLenS;
    if (over <= TARGET_LEN_TOLERANCE_S) break;
    const seg = segments[i];
    if (!seg) continue;
    const span = seg.out - seg.in;
    // Keep at least a 0.5s sliver; trim down to that floor.
    const trimmable = Math.max(0, span - 0.5);
    const trim = Math.min(over, trimmable);
    seg.out = Number((seg.out - trim).toFixed(3));
  }

  // Too short: extend toward each clip's duration ceiling.
  for (let i = 0; i < segments.length; i++) {
    const under = edl.targetLenS - edlDurationS({ ...edl, segments });
    if (under <= TARGET_LEN_TOLERANCE_S) break;
    const seg = segments[i];
    if (!seg) continue;
    const ceiling = clipDuration(library, seg.clipId);
    if (ceiling === undefined) continue;
    const headroom = Math.max(0, ceiling - seg.out);
    const extend = Math.min(under, headroom);
    seg.out = Number((seg.out + extend).toFixed(3));
  }

  return { ...edl, segments };
}

/**
 * Apply post-filters to a parsed-and-schema-valid EDL: drop unknown-clip
 * segments, then nudge length toward target. Operates on validated data so the
 * shapes are guaranteed.
 */
function postFilter(edl: Edl, library: ClipLibrary): Edl {
  const ids = clipIdSet(library);
  const kept = dropUnknownClips(edl.segments, ids);
  // Force lut to null: no color-grade .cube LUT files exist this increment, and
  // the renderer feeds any non-null lut to ffmpeg's lut3d filter as a file path,
  // so a model-invented name (e.g. "punchy-cool-contrast") would fail the render.
  // nudgeToTarget returns { ...edl, segments } over this object, so null is kept.
  const filtered: Edl = { ...edl, lut: null, segments: kept };
  // If filtering removed every segment, there is nothing to nudge — return as
  // is and let the controller bounce it (EdlSchema requires >= 1 segment).
  if (filtered.segments.length === 0) return filtered;
  return nudgeToTarget(filtered, library);
}

/**
 * Factory: returns the `LoopDeps.buildEdl` function. The returned object is the
 * parsed (and lightly post-filtered) EDL as `unknown` — the controller is the
 * single validation gate.
 */
export function makeBuildEdl(
  llm: LlmClient,
): (ctx: BuildContext) => Promise<unknown> {
  return async (ctx: BuildContext): Promise<unknown> => {
    const prompt = buildPrompt(ctx);

    const raw = await llm.complete({
      system: prompt.system,
      user: prompt.user,
      maxTokens: MAX_TOKENS,
    });

    const parsed = parseJson(raw);
    if (parsed === undefined) {
      // Nothing parseable — hand the raw value back; the controller bounces it.
      return raw;
    }

    // Only post-filter when the model produced a schema-valid EDL; otherwise
    // return the parsed object unchanged so the controller's schema error is
    // accurate (don't mask a structural problem with our filtering).
    const validated = EdlSchema.safeParse(parsed);
    if (!validated.success) return parsed;

    return postFilter(validated.data, ctx.library);
  };
}
