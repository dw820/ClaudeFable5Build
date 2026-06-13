/**
 * make-fixture.mjs — turn local clip files into the fixture library.
 *
 * For each file: ffprobe width/height/duration, upload to the source-clips
 * bucket (source of truth), and append a ClipLibrary entry. Writes
 * fixtures/clips.json. Hand-edit caption/tags afterward for better build prompts.
 *
 * Usage (from repo root):
 *   node scripts/make-fixture.mjs path/to/a.mp4 path/to/b.mp4 ...
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/make-fixture.mjs <clip1.mp4> <clip2.mp4> ...");
  process.exit(1);
}

function probe(path) {
  const r = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    path,
  ]);
  if (r.status !== 0) throw new Error(`ffprobe failed for ${path}: ${r.stderr}`);
  const j = JSON.parse(r.stdout.toString());
  const s = j.streams[0];
  const duration = Number(j.format.duration);
  if (!s || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned no usable video stream/duration for ${path}`);
  }
  return { width: s.width, height: s.height, duration };
}

const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const clips = [];

for (let i = 0; i < files.length; i++) {
  const path = files[i];
  const fname = basename(path);
  const { width, height, duration } = probe(path);
  const bytes = await readFile(path);
  const { error } = await c.storage.from("source-clips").upload(fname, bytes, {
    contentType: "video/mp4",
    upsert: true,
  });
  if (error) throw new Error(`upload ${fname} failed: ${error.message}`);
  clips.push({
    id: `c${String(i + 1).padStart(2, "0")}`,
    src: fname,
    start: 0,
    end: duration,
    duration,
    resolution: [width, height],
    transcript: [],
    caption: fname.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "),
    tags: [],
  });
  console.log(`uploaded ${fname} (${width}x${height}, ${duration.toFixed(1)}s)`);
}

await mkdir("fixtures", { recursive: true });
await writeFile("fixtures/clips.json", JSON.stringify({ projectId: process.env.FIXTURE_PROJECT_ID ?? "fixture", clips }, null, 2) + "\n");
console.log(`\nwrote fixtures/clips.json (${clips.length} clips). Edit caption/tags for richer build prompts.`);
