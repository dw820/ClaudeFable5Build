/**
 * applyOverlay — burn an EDL's caption track onto a cut video.
 *
 * Remotion is the PRIMARY path (one tested caption template, animated). If it
 * fails or exceeds a timeout, we fall back to ffmpeg `drawtext`. Either way we
 * return a path; `usedFallback` tells the caller which produced it.
 *
 * Both the Remotion renderer and the ffmpeg exec are INJECTED (real defaults,
 * overridden in tests) so the fallback path is testable without binaries and
 * nothing heavy runs at import time.
 *
 *   edl ─▶ edlToCaptionProps ─┬─▶ [PRIMARY]  Remotion bundle+render ─┐
 *                             │     (timeout / throw)                │
 *                             │            │ on failure              ▼
 *                             └─▶ [FALLBACK] ffmpeg drawtext ──▶ { path, usedFallback }
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildFfmpegCaptionArgs } from "./ffmpegCaptions.js";
import { edlToCaptionProps } from "./captionProps.js";
import type { Edl } from "../loop/types.js";

/** Default wall-clock budget for the Remotion render before we fall back. */
export const DEFAULT_REMOTION_TIMEOUT_MS = 120_000;

/** Renders captions over `basePath`, writing to `outPath`. Throws on failure. */
export type RemotionRenderer = (args: {
  basePath: string;
  outPath: string;
  edl: Edl;
  timeoutMs: number;
}) => Promise<void>;

/** Runs ffmpeg with the given argv. Throws on non-zero exit. */
export type FfmpegExec = (args: string[]) => Promise<void>;

export interface OverlayDeps {
  renderRemotion: RemotionRenderer;
  runFfmpeg: FfmpegExec;
  /** Derive the two output paths from the base path (default: suffix-based). */
  outPaths?: (basePath: string) => { remotion: string; ffmpeg: string };
  timeoutMs?: number;
}

/** Default output paths: `<base>.captioned.mp4` and `<base>.ff.mp4`. */
function defaultOutPaths(basePath: string): { remotion: string; ffmpeg: string } {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath) || ".mp4";
  const stem = path.basename(basePath, ext);
  return {
    remotion: path.join(dir, `${stem}.captioned${ext}`),
    ffmpeg: path.join(dir, `${stem}.ff${ext}`),
  };
}

/** Reject after `ms`, racing against the wrapped promise. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Remotion overlay timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Default real implementations (lazy — heavy imports happen on call)  */
/* ------------------------------------------------------------------ */

/** Real Remotion renderer: bundle the entry, select the comp, render media. */
export const defaultRemotionRenderer: RemotionRenderer = async ({
  basePath,
  outPath,
  edl,
  timeoutMs,
}) => {
  const [{ bundle }, { selectComposition, renderMedia }] = await Promise.all([
    import("@remotion/bundler"),
    import("@remotion/renderer"),
  ]);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, "remotion", "Captions.tsx");

  const serveUrl = await bundle({ entryPoint: entry });
  const inputProps = edlToCaptionProps(basePath, edl);

  const composition = await selectComposition({
    serveUrl,
    id: "Captions",
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outPath,
    inputProps,
    timeoutInMilliseconds: timeoutMs,
    overwrite: true,
  });
};

/** Real ffmpeg exec via child_process. Rejects with stderr on non-zero exit. */
export const defaultFfmpegExec: FfmpegExec = async (args) => {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
};

const DEFAULT_DEPS: OverlayDeps = {
  renderRemotion: defaultRemotionRenderer,
  runFfmpeg: defaultFfmpegExec,
};

/**
 * Burn the EDL's captions onto `basePath`. Tries Remotion (with a timeout);
 * on any failure runs the ffmpeg drawtext fallback and flips `usedFallback`.
 */
export async function applyOverlay(
  basePath: string,
  edl: Edl,
  deps: OverlayDeps = DEFAULT_DEPS,
): Promise<{ path: string; usedFallback: boolean }> {
  const outPaths = (deps.outPaths ?? defaultOutPaths)(basePath);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_REMOTION_TIMEOUT_MS;

  try {
    await withTimeout(
      deps.renderRemotion({ basePath, outPath: outPaths.remotion, edl, timeoutMs }),
      timeoutMs,
    );
    return { path: outPaths.remotion, usedFallback: false };
  } catch {
    // PRIMARY failed/timed out — fall back to ffmpeg drawtext.
    const args = buildFfmpegCaptionArgs(basePath, outPaths.ffmpeg, edl);
    await deps.runFfmpeg(args);
    return { path: outPaths.ffmpeg, usedFallback: true };
  }
}
