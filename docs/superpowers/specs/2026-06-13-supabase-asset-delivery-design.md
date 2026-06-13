# Supabase asset delivery — design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Phase:** AutoCut Phase 2 (asset delivery). See `~/.claude/plans/parsed-tumbling-stream.md`.

## Context

The preprocess pipeline (`src/preprocess/`) produces a validated `clips.json` (`ClipLibrary`) from
local video clips. The agent loop (`edit` → `render` → `verify`) runs as a long-lived **Daytona
worker** (`src/server/agent-server.ts`) and reads clips off its **local filesystem** via
`join(MEDIA_DIR, clip.src)` and ffmpeg. Today there is no way for that remote worker to obtain the
source clips, and `agent-server.ts:141,274` hardcodes `SAMPLE_LIBRARY` instead of a real library.

This change connects the two through **Supabase Storage as the source of truth** with the Daytona
disk as a download cache (architecture decision C — see memory `asset-architecture`). It builds
**both halves**: preprocess uploads source clips + the library to Storage, and the agent
materializes them onto local disk before each run.

Decisions locked during brainstorming:
- **Project:** dedicated cloud project `cepqwszgiwmgshzhobuq` (already linked via `supabase/.temp/project-ref`).
- **Bucket access:** one **private** bucket; the loop downloads with the service-role key (source footage never world-readable).
- **Library location:** `clips.json` stored as JSON in the **same** private bucket, keyed by `projectId`.
- **Scope:** upload side + download/materialize side. Standing up Daytona itself is separate infra, out of scope here.
- **Targets the post-migration brain.** Per `2026-06-13-autonomous-agent-on-daytona-design.md`, `agent-server.ts` is being reworked from the deterministic `runLoop` to an autonomous `runAgentSession(input, toolImpls, emit)`, with the gate renamed `RENDER_MODE` → `AGENT_TOOLS=stub|real`. This spec plugs into that **new** structure, not the current `runLoop`/`createLoopDeps`/`SAMPLE_LIBRARY` wiring.

## Dependency & sequencing

- The **upload side** (preprocess → Storage) is **brain-agnostic** — it touches only `src/preprocess/`, never `agent-server.ts`. It can be implemented anytime, independent of the agent migration.
- The **download/materialize side** plugs into `agent-server.ts`'s `executeRun`, which the agent migration rewrites. The agent migration's **first milestone is stub tools** (fake `render`/`search`/`grade`) that need **no real clips**. Real clips matter only at `AGENT_TOOLS=real` — so materialize is implemented as part of **enabling `AGENT_TOOLS=real`, after the agent-migration stub milestone lands**.

## Architecture: materialize at claim (brain-agnostic)

When the agent claims a run, it downloads that project's `clips.json` + all referenced clips into a
local cache dir and builds a `ClipLibrary` whose `src` values are **local cache paths**. That library
becomes `input.library` for `runAgentSession`, and the clip **files** on disk are read by the real
`render` / `search_clips` tool impls via `MEDIA_DIR` — exactly as `edit/cut.ts` reads local files
today. The Supabase concern lives at **one boundary**: `executeRun`'s input-building step (the seam
that currently hardcodes `SAMPLE_LIBRARY`). It touches neither the agent session internals nor the
frozen `edit`/`render`/`verify` modules.

This is deliberately **independent of which brain drives the loop** — the deterministic `runLoop` and
the autonomous `runAgentSession` both need (a) the `ClipLibrary` object and (b) the clip files on
local disk. Materialize provides both; only the consumer of `input.library` differs.

Rejected alternative: resolving `storage://` refs lazily inside `src/edit/cut.ts` — pushes network IO
into every render iteration and edits a frozen module.

## Storage layout & `clip.src` convention

- Bucket: **`source-clips`** (private).
- Per project: `<projectId>/<filename>` for each clip; `<projectId>/clips.json` for the library.
- On upload, preprocess sets `clip.src = "storage://<projectId>/<filename>"` — matching the existing
  `SAMPLE_LIBRARY` convention (`stubs.ts:21`).
- When **not** uploading (pure-local dev), `src` stays a relative local path as today. The upload
  flag decides the `src` format, so local-only runs keep working.

## Components

### 1. Upload — `src/preprocess/storage.ts` (new) + `cli.ts`
- `storage.ts`: an **injected** Supabase Storage client (never constructed at import — mirrors the
  injection discipline in `pgvector.ts`). Exposes `uploadClip(client, bucket, projectId, file)` and
  `uploadLibrary(client, bucket, projectId, library)`. Idempotent (`upsert: true`).
- `cli.ts:runDirectory`: a gated step, active only when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  are set. After assembling: upload each source file, rewrite its `src` to the `storage://` ref,
  then upload the finished `clips.json` to `<projectId>/clips.json`. The local `clips.json` is still
  written. Construct the real client lazily here (CLI path only), never at import.

### 2. Download — `src/server/materializeLibrary.ts` (new) + `agent-server.ts`
- `materializeLibrary.ts`: injected Storage client + a cache dir (defaults to `MEDIA_DIR`). Given a
  `projectId`: download `<projectId>/clips.json`, `ClipLibrarySchema.parse` it, download each
  `storage://<projectId>/<file>` clip to `<cacheDir>/<projectId>/<file>` **only if absent**
  (idempotent cache), and return a `ClipLibrary` whose `src` are local paths relative to the cache
  dir. Parses the `storage://` scheme; a non-`storage://` `src` is passed through unchanged.
- `agent-server.ts` (post-migration): in `executeRun`, when `AGENT_TOOLS=real`, build
  `input.library` by calling `materializeLibrary(storageClient, run.project_id, MEDIA_DIR)` instead
  of the hardcoded `SAMPLE_LIBRARY`, then pass `input` to `runAgentSession(input, toolImpls, emit)`.
  Stub-tools mode keeps `SAMPLE_LIBRARY` (no Storage, no clips needed). The real `render` /
  `search_clips` tool impls consume the local cache paths — no agent-internal changes.

### 3. Provisioning — `supabase/migrations/0002_source_clips_bucket.sql` (new)
- Create the private bucket: `insert into storage.buckets (id, name, public) values ('source-clips','source-clips', false) on conflict do nothing;`
- Setup (one-time, not code): set `SUPABASE_URL=https://cepqwszgiwmgshzhobuq.supabase.co` and
  `SUPABASE_SERVICE_ROLE_KEY=<dashboard key>` in `.env`; run `supabase db push` to apply migrations.

## Data flow

```
preprocess (laptop or sandbox)              agent / Daytona loop
──────────────────────────────             ─────────────────────────────
media/*.mov ─ probe/transcribe/VLM ─┐       run claimed (run.project_id)
                                    │              │
              assembleLibrary ──────┤              ▼
                                    │       materializeLibrary(projectId, cacheDir)
   upload each clip ── storage://───┤              │  download clips.json → parse
   upload clips.json ──────────────┘              │  download each clip if absent → cache
        (private source-clips bucket) ◀───────────┤  rewrite src → local cache path
                                                   ▼
                                          input.library → runAgentSession(input, toolImpls, emit)
                                                   real render/search_clips tools read local files
```

## Error handling
- Upload: fail loud on a Storage error (don't write a `clips.json` full of refs that didn't upload),
  matching `pgvector.ts`'s throw-on-error stance.
- Materialize: fail loud if `clips.json` or a referenced clip is missing/unreadable — a run cannot
  proceed without its assets. Surface a clear message including `projectId`/key.
- Cache: a present local file is trusted (size/etag verification is a future hardening, not now).

## Testing
- **Unit** (`storage.test` / `materializeLibrary.test`, injected fake client like `pgvector.test`):
  upload issues the expected `from(bucket).upload(key, …)` calls; materialize skips download on a
  cache hit, downloads on a miss, parses the `storage://` scheme, and returns local `src`.
- **Integration** (gated on `SUPABASE_*`): upload a real clip + `clips.json` to `source-clips`, then
  materialize into a temp dir; assert the files land, the library validates `ClipLibrarySchema`, and
  every `src` resolves to an existing local file.

## Out of scope (future)
- Standing up the Daytona workspace.
- Cache integrity (etag/size) checks and eviction.
- A queryable `clips` DB table / UI clip previews (we chose JSON-in-bucket).
- WhisperX transcription upgrade; VLM swap for tags (tracked separately).
