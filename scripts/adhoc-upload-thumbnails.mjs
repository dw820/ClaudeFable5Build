/**
 * Ad-hoc: upload per-clip thumbnails (extracted from /media videos) to a public
 * `thumbnails` bucket and stamp their public URLs into public/clips.json.
 *
 * Run: node --env-file=.env scripts/adhoc-upload-thumbnails.mjs
 * Thumbnails are pre-generated in /tmp/thumbs/<id>.jpg by the ffmpeg step.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "thumbnails";
const THUMB_DIR = "/tmp/thumbs";
const MANIFEST = "public/clips.json";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");

const storage = createClient(url, serviceKey).storage;

// Create the public bucket (ignore "already exists").
const { error: bucketErr } = await storage.createBucket(BUCKET, { public: true });
if (bucketErr && !/already exists/i.test(bucketErr.message)) throw bucketErr;
console.log(`bucket ${BUCKET}: ready`);

const lib = JSON.parse(await readFile(MANIFEST, "utf8"));

for (const clip of lib.clips) {
  const bytes = await readFile(`${THUMB_DIR}/${clip.id}.jpg`);
  const key = `${lib.projectId}/${clip.id}.jpg`;
  const { error } = await storage
    .from(BUCKET)
    .upload(key, bytes, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`upload failed (${clip.id}): ${error.message}`);
  const { data } = storage.from(BUCKET).getPublicUrl(key);
  clip.thumbnail = data.publicUrl;
  console.log(`uploaded ${clip.id} -> ${data.publicUrl}`);
}

await writeFile(MANIFEST, JSON.stringify(lib, null, 2) + "\n");
console.log(`stamped ${lib.clips.length} thumbnail URLs into ${MANIFEST}`);
