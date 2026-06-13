/**
 * Supabase Storage seam for the offline preprocess pipeline.
 *
 * Preprocess uploads each source clip and the per-project clips.json manifest
 * into the private `source-clips` bucket; the agent worker later downloads them
 * with the service-role key. As with pgvector.ts, the Storage client is
 * INJECTED — production passes a thin wrapper around the real `@supabase/supabase-js`
 * Storage client (see `makeStorageClient`), unit tests pass a fake that records
 * calls. Nothing constructs a real client at import time, so the unit suite runs
 * with no Supabase credentials and no network.
 *
 * We depend only on the `from(bucket).upload(path, body, options)` slice of the
 * client, so the mock surface stays a two-method shape rather than the whole
 * Storage client.
 */
import { extname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Clip, ClipLibrary } from "../loop/types.js";

/** The private bucket holding source clips + per-project clips.json manifests. */
export const SOURCE_CLIPS_BUCKET = "source-clips";

/**
 * The PUBLIC bucket holding per-clip poster frames. Public (unlike source-clips)
 * so the setup-screen grid can render `<img src=…>` from a static clips.json
 * without minting signed URLs. Only the downscaled poster is exposed; the source
 * video stays private in `source-clips`.
 */
export const THUMBNAILS_BUCKET = "thumbnails";

/**
 * `storage://<projectId>/<src>` — the ref a published clip points at. `src` may
 * include subpaths (e.g. `clips/wipeout.mp4`), which are preserved in the ref.
 */
export function clipStorageRef(projectId: string, src: string): string {
  return `storage://${projectId}/${src}`;
}

/**
 * `<projectId>/<src>` — the object key (path within the bucket) for a clip.
 * `src` may include subpaths (e.g. `clips/wipeout.mp4`), which are preserved in
 * the key.
 */
export function clipStorageKey(projectId: string, src: string): string {
  return `${projectId}/${src}`;
}

/** `<projectId>/clips.json` — the object key for a project's manifest. */
export function libraryKey(projectId: string): string {
  return `${projectId}/clips.json`;
}

/** `<projectId>/<id>.jpg` — the object key for a clip's poster in the thumbnails bucket. */
export function thumbnailKey(projectId: string, id: string): string {
  return `${projectId}/${id}.jpg`;
}

/**
 * The public URL a poster object resolves to. Deterministic from the project URL
 * (matches what the Storage client's `getPublicUrl` returns) so we don't need
 * that slice of the client in the injectable seam.
 */
export function publicThumbnailUrl(supabaseUrl: string, key: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${THUMBNAILS_BUCKET}/${key}`;
}

/** Map a filename to its upload content type by extension (case-insensitive). */
export function contentTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".mov":
    case ".m4v":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      // Unknown extensions deliberately fall back to a generic binary type.
      return "application/octet-stream";
  }
}

/** The slice of a Supabase Storage bucket the uploader calls. */
export interface StorageBucketLike {
  upload(
    path: string,
    body: ArrayBuffer | Uint8Array | Blob | string,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string } | null }>;
}
export interface StorageClientLike {
  from(bucket: string): StorageBucketLike;
  /**
   * Create a bucket. Optional on the seam (the source-clips path never needs it);
   * the thumbnails path calls it to lazily create the public bucket on first run.
   * The real `@supabase/supabase-js` Storage client provides it.
   */
  createBucket?(
    id: string,
    options?: { public?: boolean },
  ): Promise<{ error: { message: string } | null }>;
}

/**
 * Upload one source clip's bytes to `<projectId>/<src>` in the bucket. Throws on
 * a Storage error so a failed upload doesn't pass silently.
 */
export async function uploadClip(
  client: StorageClientLike,
  bucket: string,
  projectId: string,
  src: string,
  bytes: Uint8Array,
): Promise<void> {
  const { error } = await client.from(bucket).upload(clipStorageKey(projectId, src), bytes, {
    contentType: contentTypeFor(src),
    upsert: true,
  });
  if (error) {
    throw new Error(`source-clip upload failed (${src}): ${error.message}`);
  }
}

/**
 * Upload a project's clips.json manifest to `<projectId>/clips.json`. Throws on
 * a Storage error.
 */
export async function uploadLibrary(
  client: StorageClientLike,
  bucket: string,
  projectId: string,
  library: ClipLibrary,
): Promise<void> {
  const body = JSON.stringify(library, null, 2) + "\n";
  const { error } = await client.from(bucket).upload(libraryKey(projectId), body, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) {
    throw new Error(`clips.json upload failed: ${error.message}`);
  }
}

/**
 * Lazily create the public thumbnails bucket. Idempotent: a pre-existing bucket
 * is not an error. No-op when the client doesn't expose `createBucket` (the
 * minimal test seam) — uploads then assume the bucket exists.
 */
export async function ensureThumbnailsBucket(client: StorageClientLike): Promise<void> {
  if (!client.createBucket) return;
  const { error } = await client.createBucket(THUMBNAILS_BUCKET, { public: true });
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`thumbnails bucket create failed: ${error.message}`);
  }
}

/**
 * Upload one clip's poster JPEG to the public thumbnails bucket and return its
 * public URL. Throws on a Storage error so a failed poster doesn't pass silently.
 */
export async function uploadThumbnail(
  client: StorageClientLike,
  supabaseUrl: string,
  projectId: string,
  id: string,
  jpeg: Uint8Array,
): Promise<string> {
  const key = thumbnailKey(projectId, id);
  const { error } = await client.from(THUMBNAILS_BUCKET).upload(key, jpeg, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) {
    throw new Error(`thumbnail upload failed (${id}): ${error.message}`);
  }
  return publicThumbnailUrl(supabaseUrl, key);
}

/**
 * Optional thumbnail step for `uploadLibraryAssets`. `posterFor` returns the
 * poster bytes for a clip (or null to leave it iconless); `supabaseUrl` builds
 * the public URL stamped onto `clip.thumbnail`.
 */
export interface ThumbnailUpload {
  supabaseUrl: string;
  posterFor: (clip: Clip) => Uint8Array | null | undefined;
}

/**
 * Upload every clip's bytes, then the manifest LAST so a published clips.json
 * never references a clip that failed to upload. Returns a new library whose
 * clip `src` fields are rewritten to `storage://` refs; the input is not mutated.
 *
 * When `thumbnails` is supplied, each clip's poster is uploaded to the public
 * thumbnails bucket and its public URL is stamped onto `clip.thumbnail` BEFORE
 * the manifest is written — so both the persisted manifest and the returned
 * library carry thumbnail URLs.
 */
export async function uploadLibraryAssets(
  client: StorageClientLike,
  bucket: string,
  projectId: string,
  library: ClipLibrary,
  readClip: (src: string) => Promise<Uint8Array>,
  thumbnails?: ThumbnailUpload,
): Promise<ClipLibrary> {
  if (thumbnails) await ensureThumbnailsBucket(client);
  const clips: ClipLibrary["clips"] = [];
  for (const clip of library.clips) {
    const bytes = await readClip(clip.src);
    await uploadClip(client, bucket, projectId, clip.src, bytes);
    let next: Clip = { ...clip, src: clipStorageRef(projectId, clip.src) };
    if (thumbnails) {
      const poster = thumbnails.posterFor(clip);
      if (poster) {
        const url = await uploadThumbnail(client, thumbnails.supabaseUrl, projectId, clip.id, poster);
        next = { ...next, thumbnail: url };
      }
    }
    clips.push(next);
  }
  const uploaded: ClipLibrary = { ...library, clips };
  await uploadLibrary(client, bucket, projectId, uploaded);
  return uploaded;
}

/**
 * Production Storage client. Uses the service-role key so private-bucket writes
 * bypass RLS. Only call this from the CLI path, never at module import. Returns
 * null when the env vars are absent so callers can cleanly skip upload.
 */
export function makeStorageClient(
  url: string | undefined = process.env.SUPABASE_URL,
  serviceKey: string | undefined = process.env.SUPABASE_SERVICE_ROLE_KEY,
): StorageClientLike | null {
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey).storage as unknown as StorageClientLike;
}
