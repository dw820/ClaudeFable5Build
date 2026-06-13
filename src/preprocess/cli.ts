/**
 * Thin runner for the offline preprocess pipeline.
 *
 *   tsx src/preprocess/cli.ts <mediaDir> [outPath]
 *
 * Walks a directory of media files and, per clip IN PARALLEL, runs the three
 * steps (transcribe, frame-understand, probe), assembles a ClipLibrary, and
 * writes clips.json. Embeddings + pgvector are OFF the demo path (run only when
 * SUPABASE_* + an embed flag are set).
 *
 * All side-effecting clients are constructed HERE (never at import) so the rest
 * of the module stays unit-testable with no token / no ffmpeg.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { MEDIA_DIR_DEFAULT } from "./constants.js";
import { makeReplicateRunner, type ReplicateRunner } from "./replicateClient.js";
import { transcribeClip } from "./transcribe.js";
import {
  ffmpegFrameSampler,
  understandFrames,
  type ExecFn,
} from "./frameUnderstand.js";
import {
  assembleLibrary,
  writeClipsJson,
  type ClipMeta,
  type ClipParts,
} from "./assemble.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);

/** Binary-safe exec used by the ffmpeg frame sampler (stdout as latin1). */
const execBinary: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(out).toString("binary"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err)}`));
      }
    });
  });

/** Probe duration + resolution via ffprobe (JSON). */
async function probeClip(path: string): Promise<ClipMeta> {
  const { stdout } = await execText("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    path,
  ]);
  const json = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const stream = json.streams?.[0] ?? {};
  return {
    durationS: Number(json.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
  };
}

/** Text exec for ffprobe (stdout as utf8). */
const execText: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err)}`));
      }
    });
  });

/** Stable clip id from a filename (basename without extension). */
export function clipIdFromPath(path: string): string {
  return basename(path, extname(path)).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Run all three steps for one clip. Exposed so a custom driver can inject test
 * doubles; `runDirectory` wires the production clients.
 */
export async function preprocessClip(
  runner: ReplicateRunner,
  sampler: ReturnType<typeof ffmpegFrameSampler>,
  probe: (path: string) => Promise<ClipMeta>,
  mediaDir: string,
  absPath: string,
): Promise<ClipParts> {
  // Whisper runs on Replicate, which needs a URI — not a local path. Until clips
  // live in Storage (Phase 2: pass the public URL), upload the bytes inline: the
  // Replicate SDK auto-uploads a Blob/File input and substitutes the hosted URL.
  // The named File preserves the extension so whisper can demux the container.
  const audio = new File([await readFile(absPath)], basename(absPath));
  const [transcript, understanding, meta] = await Promise.all([
    transcribeClip(runner, { audio }),
    understandFrames(runner, sampler, { clipPath: absPath }),
    probe(absPath),
  ]);
  return {
    id: clipIdFromPath(absPath),
    // clip.src is the local path RELATIVE to MEDIA_DIR (the frozen convention).
    src: relative(mediaDir, absPath),
    meta,
    transcript,
    caption: understanding.caption,
    tags: understanding.tags,
  };
}

/** Walk a media dir, preprocess every clip in parallel, write clips.json. */
export async function runDirectory(
  mediaDir: string,
  outPath: string,
  projectId: string,
): Promise<void> {
  const runner = makeReplicateRunner();
  const sampler = ffmpegFrameSampler(execBinary);

  const entries = await readdir(mediaDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && VIDEO_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(mediaDir, e.name))
    .sort();

  if (files.length === 0) {
    throw new Error(`no media files found in ${mediaDir}`);
  }

  const parts = await Promise.all(
    files.map((f) => preprocessClip(runner, sampler, probeClip, mediaDir, f)),
  );

  const library = assembleLibrary(projectId, parts);
  await writeClipsJson(library, outPath);
  // eslint-disable-next-line no-console
  console.log(`wrote ${library.clips.length} clips → ${outPath}`);
}

/** Entry point when invoked directly. */
async function main(): Promise<void> {
  const mediaDir = process.argv[2] ?? MEDIA_DIR_DEFAULT;
  const outPath = process.argv[3] ?? join(mediaDir, "clips.json");
  const projectId = process.env.PROJECT_ID ?? (basename(mediaDir) || "project");
  await runDirectory(mediaDir, outPath, projectId);
}

// Run only when executed as a script (not when imported by tests).
if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
