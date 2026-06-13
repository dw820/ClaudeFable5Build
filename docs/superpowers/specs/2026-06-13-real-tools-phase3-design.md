# Real tools (Phase 3, increment 1) — design

## Goal

Promote the autonomous agent from **stub tools** to **real tools** for `build_edl`,
`render`, and `grade`, leaving `search_clips` as a stub. This is the first Phase 3
increment: prove the autonomous Claude session can compose, render (ffmpeg), and
vision-grade a **real** video from a small fixture library — on Daytona, shipping a
real mp4 to Supabase Storage — without standing up the preprocess/pgvector pipeline.

The stub-tools acceptance test (`docs/daytona-stub-test.md`) is already green. This
builds directly on it: same bus, same harness, same caps — only the injected
`ToolImpls` change.

## Scope

**In:**
- A new adapter `makeRealToolImpls()` bridging the existing real modules
  (`makeBuildEdl`, `makeRender`, `makeGrade`) into the agent's `ToolImpls` shape.
- Flip the `throw` in `defaultRunSession` (`agent-server.ts`) so `AGENT_TOOLS=real`
  constructs and injects the real impls.
- A committed fixture `ClipLibrary` (`clips.json`) describing 2–3 user-supplied clips.
- Source clips delivered via the `source-clips` Storage bucket → downloaded to
  `MEDIA_DIR` on the sandbox (the locked asset architecture: Storage = source of
  truth, Daytona disk = cache).
- `ffmpeg`/`ffprobe` installed in the sandbox when running real mode.

**Out (explicitly deferred):**
- `search_clips` real impl — stays a stub returning the library's clips. No pgvector,
  no embeddings, no preprocess pipeline.
- Remotion captions — `render` uses the ffmpeg `drawtext` fallback (`usedFallback: true`).
  No headless chromium.
- Any change to the agent prompt, harness, caps, event contract, or `handleRun`
  upload path.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| First increment | **Everything real except `search_clips`** | Search needs a real library + pgvector; that's a separate, larger effort. Build/render/grade are the product's core loop and only need a handful of fixture clips. |
| Clip delivery | **Storage-as-source + local-first (A2)** | Matches the locked asset architecture. Develop + unit-test offline, real-smoke locally (laptop ffmpeg), then Daytona for the true end-to-end. Fast iteration. |
| Captions | **ffmpeg drawtext (Remotion deferred)** | `applyOverlay` already falls back to ffmpeg on any Remotion failure. Skipping Remotion drops the heaviest infra (headless chromium) with no code change — just don't install it. |
| Render → Storage | **No change** | `handleRun`/`uploadRender` already read the render's local file and upload to `renders`, setting `shipped_render`. Real render only needs to produce a real local path. |

## Architecture

```
AGENT_TOOLS=real
      │
      ▼
defaultRunSession (agent-server.ts)
      │  constructs:
      │    • AnthropicClient(ANTHROPIC_API_KEY)         ← buildEdl text + grade vision
      │    • fixtureLibrary = load(clips.json)          ← src resolved vs MEDIA_DIR
      │    • makeRealToolImpls({ llm, library, brief, rubric, exec })
      ▼
runAgentSession(...)  ── unchanged ──▶  createAutocutTools(impls)
                                              │
   search_clips ─▶ impls.searchClips ─▶ library.clips                (stub passthrough)
   build_edl    ─▶ impls.buildEdl     ─▶ makeBuildEdl(llm)(BuildContext)  (real LLM)
   render       ─▶ impls.render       ─▶ makeRender(library,{cutVideo, ffmpeg-overlay})
   grade        ─▶ impls.grade        ─▶ makeGrade(llm,{exec})       (ffmpeg + vision)
```

### The adapter: `src/agent/realTools.ts`

`makeRealToolImpls(deps): ToolImpls`, with everything injected so it unit-tests
offline (the repo's established DI pattern — no module constructs a client or shells
out at import time).

```
interface RealToolDeps {
  llm: LlmClient;              // AnthropicClient in prod, FakeLlmClient in tests
  library: ClipLibrary;        // the fixture library (also the render source)
  brief: string;               // per-run, closed over
  rubric: Rubric;
  exec?: ExecFn;               // ffmpeg/ffprobe runner; defaults to deps.ts defaultExec
  cutVideo?: ...; applyOverlay?: ...;   // overridable for tests
}
```

**`searchClips(query, library)`** → `library.clips`. Identical to the stub; search is
out of scope. (Kept in the adapter rather than reusing `makeStubToolImpls` so the real
toolset is one self-contained unit.)

**`buildEdl(clipIds, rationale, library)`** → bridges to `makeBuildEdl(llm)`, whose
signature is `(BuildContext) => Promise<unknown>`. The bridge:
- scope `library` to the agent-selected `clipIds` (fall back to the full library if
  empty), so the LLM composes only from what the agent chose;
- fold the agent's `rationale` into `brief` (e.g. append `"\n\nEditor's note: <rationale>"`)
  so the builder knows the agent's intent;
- pass a constant `iteration: 1` (every `build_edl` is a fresh build): the agent
  owns self-correction and conveys it via `rationale`, so the builder's
  controller-style revision block — which needs `previousFeedback`/`previousEdl`
  we don't have — must never fire;
- return the builder's `unknown` result unchanged — the `build_edl` tool validates it
  with `EdlSchema`, exactly as today.

**`render(edl)`** → `makeRender(library, { cutVideo, applyOverlay })` where
`applyOverlay` is pinned to the ffmpeg path by injecting a `renderRemotion` that rejects
(or calling `applyOverlay(base, edl, { renderRemotion: reject, runFfmpeg: defaultFfmpegExec })`).
Output is a real local mp4 path under `os.tmpdir()`.

**`grade(render, rubric)`** → `makeGrade(llm, { exec })`. `extractKeyframes` ffprobe/ffmpeg
on `render.output`, then Claude Opus vision via `AnthropicClient.complete({ images })`.
Unrecoverable extraction/LLM failure already yields the sentinel failing grade.

### Fixture library

A committed `clips.json` (default location `fixtures/clips.json`, overridable via env)
validated by `ClipLibrarySchema`:
- `src` = bare filename (e.g. `wipeout.mp4`), resolved against `MEDIA_DIR` by
  `ffmpegArgs.mediaDir()`.
- `duration` + `resolution` filled by `ffprobe`-ing the user's files.
- `transcript: []` (no preprocess); `caption` + `tags` describe the clip for the
  builder prompt.

The video files are uploaded once to the `source-clips` bucket (source of truth). The
provisioner downloads them into `MEDIA_DIR` (cache) at sandbox setup when
`AGENT_TOOLS=real`.

### Wiring & infra

- `defaultRunSession` real branch: build `AnthropicClient`, load `clips.json`, construct
  `makeRealToolImpls`, inject into `runAgentSession`. Replaces the current `throw`.
- Provisioner (`daytona-provision.ts`): when real, add `sudo apt-get install -y ffmpeg`,
  download `source-clips/*` → `MEDIA_DIR`, and set `MEDIA_DIR` + `AGENT_TOOLS=real` in
  `envVars`.
- Caps unchanged: `maxTurns 12`, `maxBudgetUsd 0.5`, `wallclockMs 120_000`.

## Testing

1. **Unit (offline, no ffmpeg/key):** `realTools.test.ts` — drive the adapter with
   `FakeLlmClient` and a fake `exec`. Assert the `buildEdl` BuildContext bridge (clip
   scoping, rationale fold, iteration), `render` uses the ffmpeg path
   (`usedFallback: true`), `grade` passes frames to the LLM, `searchClips` passthrough.
2. **Local real smoke:** run the real impls against the fixture on the laptop (has
   ffmpeg) — confirm a real mp4 is produced and Opus returns a structured grade.
3. **Daytona integration:** provision with `AGENT_TOOLS=real`, queue a run, watch the
   autonomous agent cut + grade + ship a **real** mp4 to the `renders` bucket;
   `runs.status → shipped`, `shipped_render` set to the uploaded URL.

## Risks

- **Harsh grades on short fixtures.** Opus may never hit 7/7 on 2–3 raw clips → the
  harness ships best-so-far (status may be `failed` with a non-empty `shipped_render`).
  Acceptable — it still proves the real loop; not a blocker.
- **Real-footage ffmpeg variety.** Mixed codecs/resolutions/fps can stress the
  trim→scale→pad→concat filtergraph. Mitigation: the local smoke catches this before
  Daytona; the `usedFallback` flag and ffmpeg stderr surface failures.
- **Cost per iteration.** Real `build_edl` + `grade` (vision) calls cost money each
  self-correction round; bounded by `maxBudgetUsd 0.5` and `maxTurns 12`.
- **Basic captions.** drawtext until Remotion is wired in a later increment; this can
  depress `caption_legibility` scores. Expected and acceptable for this increment.

## Out of scope / next increments

- Real `search_clips` (pgvector + embeddings + preprocess pipeline + real library).
- Remotion captions (headless chromium in the sandbox image).
- Baking ffmpeg + a real library into a Daytona snapshot (vs. install-on-provision).
