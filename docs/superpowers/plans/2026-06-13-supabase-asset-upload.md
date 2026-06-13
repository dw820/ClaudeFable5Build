# Supabase Asset Upload (preprocess → Storage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the preprocess CLI upload each source clip plus the `clips.json` manifest to a private Supabase Storage bucket, rewriting `clip.src` to `storage://<projectId>/<file>` refs, so a remote worker can later fetch them.

**Architecture:** Mirror the existing inject-don't-import discipline (`src/preprocess/pgvector.ts`, `replicateClient.ts`). A new `src/preprocess/storage.ts` defines a minimal injectable Storage interface + pure helpers + upload functions; `cli.ts` lazily constructs the real client and runs the upload only when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set. This is the **upload half** of the asset-delivery spec; the download/materialize half is deferred to the agent-migration `AGENT_TOOLS=real` phase.

**Tech Stack:** TypeScript (ESM), Vitest, `@supabase/supabase-js` (already a dependency), Supabase Storage + migrations.

**Spec:** `docs/superpowers/specs/2026-06-13-supabase-asset-delivery-design.md`

---

## File Structure

- **Create** `src/preprocess/storage.ts` — Storage interface (injectable), pure ref/key/content-type helpers, `uploadClip` / `uploadLibrary` / `uploadLibraryAssets`, and a lazy `makeStorageClient`.
- **Create** `supabase/migrations/0002_source_clips_bucket.sql` — private `source-clips` bucket.
- **Modify** `src/preprocess/cli.ts` — gated upload step in `runDirectory`.
- **Modify** `src/preprocess/preprocess.test.ts` — unit tests (`describe("storage")`), injected fake client.
- **Modify** `src/preprocess/preprocess.integration.test.ts` — gated real-bucket upload test.
- **Modify** `.env.example` — document the upload gate + bucket.

---

## Task 1: Storage bucket migration

**Files:**
- Create: `supabase/migrations/0002_source_clips_bucket.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0002_source_clips_bucket.sql
-- Private bucket for source video clips + per-project clips.json manifest.
-- Written by preprocess (upload). Downloaded by the agent worker (service-role
-- key) into a local cache before render. Private: source footage is never
-- world-readable; access is via the service role only.
insert into storage.buckets (id, name, public)
values ('source-clips', 'source-clips', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Preview against the linked project (no apply)**

Run: `supabase db push --dry-run`
Expected: lists `0002_source_clips_bucket.sql` as pending. (Requires `supabase link` + `SUPABASE_DB_PASSWORD`; if not linked yet, skip — applied during setup.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0002_source_clips_bucket.sql
git commit -m "feat(supabase): add private source-clips storage bucket migration"
```

---

## Task 2: Pure helpers + Storage interface in storage.ts

**Files:**
- Create: `src/preprocess/storage.ts`
- Test: `src/preprocess/preprocess.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/preprocess.test.ts` (new import + a new describe block at the end of the file):

```typescript
import {
  SOURCE_CLIPS_BUCKET,
  clipStorageRef,
  clipStorageKey,
  libraryKey,
  contentTypeFor,
} from "./storage.js";

describe("storage helpers", () => {
  it("builds the storage ref and bucket key from projectId + src", () => {
    expect(clipStorageRef("proj", "a.mov")).toBe("storage://proj/a.mov");
    expect(clipStorageKey("proj", "a.mov")).toBe("proj/a.mov");
    expect(libraryKey("proj")).toBe("proj/clips.json");
  });

  it("maps file extensions to content types (case-insensitive)", () => {
    expect(contentTypeFor("clip.mp4")).toBe("video/mp4");
    expect(contentTypeFor("CLIP.MOV")).toBe("video/quicktime");
    expect(contentTypeFor("clip.webm")).toBe("video/webm");
    expect(contentTypeFor("clip.unknown")).toBe("application/octet-stream");
  });

  it("exposes the bucket name constant", () => {
    expect(SOURCE_CLIPS_BUCKET).toBe("source-clips");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "storage helpers"`
Expected: FAIL — `Cannot find module './storage.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/preprocess/storage.ts`:

```typescript
/**
 * Upload source clips + the clips.json manifest to a private Supabase Storage
 * bucket. The Storage client is INJECTED (mirrors pgvector.ts / replicateClient.ts)
 * so unit tests mock it and nothing connects at import time. Production builds the
 * real client lazily via `makeStorageClient`, only on the CLI path.
 */
import { extname } from "node:path";
import type { ClipLibrary } from "../loop/types.js";

/** Private bucket holding <projectId>/<file> clips + <projectId>/clips.json. */
export const SOURCE_CLIPS_BUCKET = "source-clips";

/** The value stored in clip.src after upload (matches the SAMPLE_LIBRARY convention). */
export function clipStorageRef(projectId: string, src: string): string {
  return `storage://${projectId}/${src}`;
}

/** The Storage object key (path within the bucket) for a clip. */
export function clipStorageKey(projectId: string, src: string): string {
  return `${projectId}/${src}`;
}

/** The Storage object key for a project's clips.json manifest. */
export function libraryKey(projectId: string): string {
  return `${projectId}/clips.json`;
}

/** Best-effort content type by extension; Storage stores the bytes regardless. */
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
      return "application/octet-stream";
  }
}

/** Minimal injectable Storage surface (mirrors agent-server.ts StorageClient). */
export interface StorageBucketLike {
  upload(
    path: string,
    body: ArrayBuffer | Uint8Array | Blob | string,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string } | null }>;
}
export interface StorageClientLike {
  from(bucket: string): StorageBucketLike;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "storage helpers"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/storage.ts src/preprocess/preprocess.test.ts
git commit -m "feat(preprocess): storage ref/key/content-type helpers + injectable Storage interface"
```

---

## Task 3: uploadClip + uploadLibrary

**Files:**
- Modify: `src/preprocess/storage.ts`
- Test: `src/preprocess/preprocess.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/preprocess/preprocess.test.ts` (extend the storage import with `uploadClip, uploadLibrary, type StorageClientLike, type StorageBucketLike`):

```typescript
import { uploadClip, uploadLibrary } from "./storage.js";

describe("storage upload", () => {
  type Call = { bucket: string; path: string; contentType?: string; upsert?: boolean };

  function fakeClient(error: { message: string } | null = null) {
    const calls: Call[] = [];
    const client = {
      from(bucket: string) {
        return {
          async upload(path: string, _body: unknown, options?: { contentType?: string; upsert?: boolean }) {
            calls.push({ bucket, path, contentType: options?.contentType, upsert: options?.upsert });
            return { error };
          },
        };
      },
    };
    return { client, calls };
  }

  it("uploads a clip to <projectId>/<src> with content type + upsert", async () => {
    const { client, calls } = fakeClient();
    await uploadClip(client, "source-clips", "proj", "a.mov", new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      { bucket: "source-clips", path: "proj/a.mov", contentType: "video/quicktime", upsert: true },
    ]);
  });

  it("throws when a clip upload errors", async () => {
    const { client } = fakeClient({ message: "boom" });
    await expect(
      uploadClip(client, "source-clips", "proj", "a.mov", new Uint8Array()),
    ).rejects.toThrow(/source-clip upload failed \(a\.mov\): boom/);
  });

  it("uploads the library as <projectId>/clips.json JSON", async () => {
    const { client, calls } = fakeClient();
    const lib = { projectId: "proj", clips: [] } as unknown as Parameters<typeof uploadLibrary>[3];
    await uploadLibrary(client, "source-clips", "proj", lib);
    expect(calls[0]).toMatchObject({
      bucket: "source-clips",
      path: "proj/clips.json",
      contentType: "application/json",
      upsert: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "storage upload"`
Expected: FAIL — `uploadClip is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `src/preprocess/storage.ts`:

```typescript
/** Upload one source clip's bytes to <projectId>/<src>. Throws on Storage error. */
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

/** Upload the clips.json manifest to <projectId>/clips.json. Throws on error. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "storage upload"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/storage.ts src/preprocess/preprocess.test.ts
git commit -m "feat(preprocess): uploadClip + uploadLibrary to Storage"
```

---

## Task 4: uploadLibraryAssets orchestration (read → upload → rewrite src)

**Files:**
- Modify: `src/preprocess/storage.ts`
- Test: `src/preprocess/preprocess.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/preprocess/preprocess.test.ts` (extend storage import with `uploadLibraryAssets`):

```typescript
import { uploadLibraryAssets } from "./storage.js";

describe("uploadLibraryAssets", () => {
  it("uploads each clip + the manifest, rewriting src to storage:// refs", async () => {
    const uploads: string[] = [];
    const client = {
      from() {
        return {
          async upload(path: string) {
            uploads.push(path);
            return { error: null };
          },
        };
      },
    };
    const lib = assembleLibrary("proj", [
      partFixture({ id: "c01", src: "a.mov" }),
      partFixture({ id: "c02", src: "b.mp4" }),
    ]);

    const readClip = async (src: string) => new Uint8Array([src.length]);
    const out = await uploadLibraryAssets(client, "source-clips", "proj", lib, readClip);

    // Each source clip uploaded, then the manifest last.
    expect(uploads).toEqual(["proj/a.mov", "proj/b.mp4", "proj/clips.json"]);
    // src rewritten to storage refs in the returned library.
    expect(out.clips.map((c) => c.src)).toEqual([
      "storage://proj/a.mov",
      "storage://proj/b.mp4",
    ]);
    // Original library object not mutated.
    expect(lib.clips[0]!.src).toBe("a.mov");
  });
});
```

(Note: `assembleLibrary` and `partFixture` already exist in this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "uploadLibraryAssets"`
Expected: FAIL — `uploadLibraryAssets is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/preprocess/storage.ts`:

```typescript
/**
 * Upload every clip's bytes + the manifest, returning a NEW library whose
 * clip.src values are rewritten to storage:// refs. `readClip` resolves a
 * clip's (mediaDir-relative) src to its bytes — injected so this is testable
 * without the filesystem. The manifest is uploaded LAST, after every clip, so a
 * published clips.json never references a clip that failed to upload.
 */
export async function uploadLibraryAssets(
  client: StorageClientLike,
  bucket: string,
  projectId: string,
  library: ClipLibrary,
  readClip: (src: string) => Promise<Uint8Array>,
): Promise<ClipLibrary> {
  const clips = [];
  for (const clip of library.clips) {
    const bytes = await readClip(clip.src);
    await uploadClip(client, bucket, projectId, clip.src, bytes);
    clips.push({ ...clip, src: clipStorageRef(projectId, clip.src) });
  }
  const uploaded: ClipLibrary = { ...library, clips };
  await uploadLibrary(client, bucket, projectId, uploaded);
  return uploaded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "uploadLibraryAssets"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/storage.ts src/preprocess/preprocess.test.ts
git commit -m "feat(preprocess): uploadLibraryAssets — upload clips + manifest, rewrite src refs"
```

---

## Task 5: Lazy real Storage client (makeStorageClient)

**Files:**
- Modify: `src/preprocess/storage.ts`

- [ ] **Step 1: Add the lazy constructor (no unit test — thin SDK wrapper, mirrors makeReplicateRunner)**

Append to `src/preprocess/storage.ts`:

```typescript
import { createClient } from "@supabase/supabase-js";

/**
 * Production Storage client. Lazily constructs the real Supabase SDK with the
 * SERVICE-ROLE key (private-bucket writes bypass RLS). Only call from the CLI
 * path where env is present — never at module import. Returns null when the
 * required env is absent, so callers can cleanly skip upload.
 */
export function makeStorageClient(
  url: string | undefined = process.env.SUPABASE_URL,
  serviceKey: string | undefined = process.env.SUPABASE_SERVICE_ROLE_KEY,
): StorageClientLike | null {
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey).storage as unknown as StorageClientLike;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/preprocess/storage.ts
git commit -m "feat(preprocess): makeStorageClient (lazy, service-role, null when unconfigured)"
```

---

## Task 6: Wire the gated upload into cli.ts

**Files:**
- Modify: `src/preprocess/cli.ts` (imports near top; `runDirectory` after `assembleLibrary`)

- [ ] **Step 1: Add imports**

In `src/preprocess/cli.ts`, add to the `node:fs/promises` import and a new storage import:

```typescript
import { readdir, readFile } from "node:fs/promises"; // readFile already added earlier
import {
  makeStorageClient,
  uploadLibraryAssets,
  SOURCE_CLIPS_BUCKET,
} from "./storage.js";
```

- [ ] **Step 2: Add the gated upload in `runDirectory`**

Replace the tail of `runDirectory` (the `assembleLibrary` → `writeClipsJson` → `console.log` block) with:

```typescript
  let library = assembleLibrary(projectId, parts);

  // Upload to Storage when configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
  // On upload, clip.src is rewritten to a storage:// ref; otherwise src stays a
  // local relative path (pure-local dev still works).
  const storage = makeStorageClient();
  if (storage) {
    library = await uploadLibraryAssets(
      storage,
      SOURCE_CLIPS_BUCKET,
      projectId,
      library,
      (src) => readFile(join(mediaDir, src)).then((b) => new Uint8Array(b)),
    );
    // eslint-disable-next-line no-console
    console.log(`uploaded ${library.clips.length} clips + manifest → ${SOURCE_CLIPS_BUCKET}/${projectId}/`);
  }

  await writeClipsJson(library, outPath);
  // eslint-disable-next-line no-console
  console.log(`wrote ${library.clips.length} clips → ${outPath}`);
```

- [ ] **Step 3: Typecheck + full preprocess unit suite (no regressions)**

Run: `npx tsc --noEmit && npx vitest run src/preprocess/preprocess.test.ts`
Expected: typecheck clean; all unit tests pass (existing + new storage tests).

- [ ] **Step 4: Local smoke test — upload OFF (no Supabase env)**

Run: `npx tsx --env-file=.env src/preprocess/cli.ts "$(pwd)/media" 2>&1 | grep -v Bearer`
Expected: `wrote N clips → …/media/clips.json`, NO "uploaded …" line (env empty → upload skipped), `clip.src` stays a relative path. (Confirms backward compatibility.)

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/cli.ts
git commit -m "feat(preprocess): upload clips + manifest to Storage when configured"
```

---

## Task 7: Gated integration test (real bucket)

**Files:**
- Modify: `src/preprocess/preprocess.integration.test.ts`

- [ ] **Step 1: Write the gated test**

Add to `src/preprocess/preprocess.integration.test.ts`, **inside the existing `describe("preprocess integration", …)` block** (it already has `hasSupabase` + imports `assembleLibrary`):

```typescript
// top-of-file import (alongside the existing imports):
import { makeStorageClient, uploadLibraryAssets, SOURCE_CLIPS_BUCKET } from "./storage.js";

// inside describe("preprocess integration", () => { … }):
it.skipIf(!hasSupabase)(
  "uploads clips + manifest to the real source-clips bucket",
  async () => {
    const client = makeStorageClient();
    if (!client) throw new Error("expected a Storage client when SUPABASE_* set");
    const lib = assembleLibrary("itest", [
      {
        id: "c01",
        src: "c01.mov",
        meta: { durationS: 3, width: 1080, height: 1920 },
        transcript: [],
        caption: "x",
        tags: [],
      },
    ]);
    const out = await uploadLibraryAssets(
      client,
      SOURCE_CLIPS_BUCKET,
      "itest",
      lib,
      async () => new Uint8Array([0, 1, 2, 3]),
    );
    expect(out.clips[0]!.src).toBe("storage://itest/c01.mov");
  },
  120_000,
);
```

(Note: requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env` and the `source-clips` bucket applied via Task 1. `assembleLibrary` is already imported in this file. `hasSupabase` currently checks `SUPABASE_KEY`; update it to also accept the service-role key — see Step 2.)

- [ ] **Step 2: Broaden the `hasSupabase` gate**

In `src/preprocess/preprocess.integration.test.ts`, change:

```typescript
const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_KEY;
```
to:
```typescript
const hasSupabase =
  !!process.env.SUPABASE_URL &&
  (!!process.env.SUPABASE_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY);
```

- [ ] **Step 3: Run (skips unless SUPABASE_* set)**

Run: `npx vitest run src/preprocess/preprocess.integration.test.ts`
Expected: WITHOUT Supabase env → the upload test is skipped. WITH env + bucket applied → it passes (uploads land, src rewritten).

- [ ] **Step 4: Commit**

```bash
git add src/preprocess/preprocess.integration.test.ts
git commit -m "test(preprocess): gated integration test for real Storage upload"
```

---

## Task 8: Document the upload gate in .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update the Supabase comment block**

In `.env.example`, replace the Supabase section comment so it documents the upload trigger:

```bash
# Supabase — preprocess uploads source clips + clips.json to the private
# `source-clips` bucket when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are BOTH set
# (otherwise clip.src stays a local path and nothing is uploaded). Also: pgvector
# (off the demo path) + the agent event writer.
SUPABASE_URL=
SUPABASE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: document Supabase upload gate in .env.example"
```

---

## Setup (one-time, run by the user — not a code task)

1. Set in `.env`: `SUPABASE_URL=https://cepqwszgiwmgshzhobuq.supabase.co` and `SUPABASE_SERVICE_ROLE_KEY=<dashboard → Project Settings → API → service_role key>`.
2. Apply migrations: `supabase db push` (creates the `source-clips` bucket; needs `supabase link` + `SUPABASE_DB_PASSWORD`).
3. Re-run the CLI: `npx tsx --env-file=.env src/preprocess/cli.ts "$(pwd)/media"` → expect the "uploaded N clips + manifest" line, and `media/clips.json` now holding `storage://` refs.

---

## Verification (end-to-end)

- **Unit:** `npx vitest run src/preprocess/preprocess.test.ts` — all pass (helpers, upload, orchestration; existing transcribe/assemble/pgvector tests still green).
- **Typecheck:** `npx tsc --noEmit` — clean.
- **Backward-compat:** CLI with no Supabase env writes a local `clips.json` with relative `src` and prints no upload line.
- **Integration (gated):** with `SUPABASE_*` set + bucket applied, `preprocess.integration.test.ts` upload test passes; manually confirm objects exist under `source-clips/<projectId>/` (Supabase dashboard → Storage) and `clips.json` is present at `<projectId>/clips.json`.

## Out of scope (this plan)

Download/materialize side (`materializeLibrary.ts` + `agent-server.ts` wiring) — deferred to the agent-migration `AGENT_TOOLS=real` phase per the spec. Standing up Daytona. Cache integrity checks.
