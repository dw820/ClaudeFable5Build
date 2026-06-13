/**
 * fetch-clips.mjs — download the source-clips bucket into MEDIA_DIR (the cache).
 * Run in the sandbox (or locally) before a real-tools run. Skips folders/prefixes.
 *
 * Usage (from repo root):
 *   MEDIA_DIR=/home/daytona/media node scripts/fetch-clips.mjs
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "./media";
const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

await mkdir(MEDIA_DIR, { recursive: true });

const { data: entries, error } = await c.storage.from("source-clips").list("", { limit: 1000 });
if (error) throw new Error(`list source-clips failed: ${error.message}`);

// Real objects have an id; prefixes (folders like "itest") do not.
const vids = (entries ?? []).filter((f) => f.id && /\.(mp4|mov|webm|m4v)$/i.test(f.name));
if (vids.length === 0) {
  console.error("no video files at the top level of the source-clips bucket");
  process.exit(1);
}

for (const f of vids) {
  const { data, error: dErr } = await c.storage.from("source-clips").download(f.name);
  if (dErr) throw new Error(`download ${f.name} failed: ${dErr.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  await writeFile(join(MEDIA_DIR, f.name), buf);
  console.log(`fetched ${f.name} -> ${join(MEDIA_DIR, f.name)} (${buf.length} bytes)`);
}
console.log(`\ndone: ${vids.length} clips in ${MEDIA_DIR}`);
