# Preprocess scene-level visual understanding — design

## Goal

Give the editing agent **timed, per-scene visual understanding** of each source clip,
so it can choose segment in/out points by *content* instead of blind seconds.

Today the agent plans entirely from text: `search_clips` and `build_edl` read one
whole-clip `caption` + `tags` (from a single, front-weighted VLM frame) plus the
transcript. A long multi-scene clip is therefore described by one caption of one early
frame — everything past the first few seconds is invisible to every downstream step.
This change makes preprocess detect scenes within each clip and caption each one, then
surfaces those timed captions to the builder.

This is an **offline preprocess** change. The agent loop never watches video (by
design — the loop runs many iterations; preprocess runs once), so all new visual
compute lands in preprocess where it is paid for exactly once.

## Scope

**In:**
- New `scenes.ts`: ffmpeg scene detection + pure boundary math (`detectScenes`).
- Extend `frameUnderstand.ts`: midpoint-frame sampling per scene window +
  `understandScenes` (captions each window via the existing VLM path).
- Additive optional `scenes` field on `ClipSchema` (`types.ts`) — backward-compatible.
- `assemble.ts`: carry `scenes` onto the `Clip`; derive the whole-clip `caption`/`tags`
  summary from the scenes (no extra model call).
- `builder/prompt.ts` `describeClip` + `tools.ts` `search_clips`: surface scene lines
  (with timestamps) to the agent when a clip has >1 scene.
- `cli.ts`: wire scene detection + understanding into `preprocessClip`.
- Fixes the existing front-weighting bug as a side effect (every caption now comes from
  the true midpoint of its window, not the first ~6s of the clip).

**Out (explicitly deferred):**
- **Per-scene embeddings / pgvector.** Clip-level embedding (off the demo path) is
  unchanged; semantic search stays whole-clip. Noted as future once retrieval needs it.
- **PySceneDetect.** ffmpeg scene filter only. The injected-exec seam in `detectScenes`
  lets us swap in a Python detector later behind the same interface if quality demands.
- **Soft-transition detection beyond the cadence backstop.** Crossfades/dissolves are
  caught by periodic sampling (`SCENE_MAX_S`), not by the detector itself.
- **Any change to the EDL schema, renderer, grader, harness, caps, or upload path.**

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where scene data lives | **Additive `scenes?: Scene[]` on `ClipSchema`** | Backward-compatible: old `clips.json` still validates; short single-scene clips look exactly as today; `caption`/`tags` stay as the whole-clip summary. |
| Detection mechanism | **ffmpeg `select='gt(scene,T)',showinfo`** | Zero new dependency (ffmpeg is already the universal media tool here). Reliable on hard cuts. |
| Granularity bound | **`MIN_SCENE_S` floor (merge), not a fixed scene count** | A flat cap (e.g. 8) discards exactly the detail we are adding and punishes long clips most. Merging cuts closer than ~2s debounces false positives while letting scene count scale with content × length. |
| Soft-transition / long-take coverage | **`SCENE_MAX_S` cadence ceiling** | Pixel-difference detection misses gradual changes; subdividing any window longer than ~15s guarantees the whole clip is sampled regardless. |
| Cost runaway guard | **`SCENE_BUDGET` that *coarsens*, never truncates** | A degenerate clip (strobe, heavy handheld) could explode VLM calls. On exceeding the budget, raise the effective min-scene length so the **whole clip stays covered end-to-end** with fewer, longer windows — granularity degrades, coverage never does. Logged when it triggers (no silent cap). |
| Whole-clip `caption`/`tags` | **Derived from scenes (free)** | `caption` = the caption of the scene covering the clip's temporal midpoint (deterministic); `tags` = de-duped union of all scene tags (cap 8). Reuses scene results — no extra model call. Single-scene clips are identical to today. |
| Per-scene captioning | **One midpoint frame per window** | Mirrors the current single-representative-frame approach per window; keeps cost ~1 VLM call per scene and fixes front-weighting. |

### Default knob values (all env-overridable)

| Knob | Default | Meaning |
|---|---|---|
| `SCENE_THRESHOLD` | `0.4` | ffmpeg `scene` score above which a frame is a cut. Lower = more sensitive. |
| `MIN_SCENE_S` | `2` | Cuts closer than this merge — the granularity floor / false-positive debounce. |
| `SCENE_MAX_S` | `15` | Any window longer than this is subdivided — the soft-transition / long-take backstop. |
| `SCENE_BUDGET` | `60` | Max VLM calls per clip before coverage coarsens (does not truncate). |

## Architecture

```
preprocessClip(clip)                                  (cli.ts, per clip, in parallel)
   │
   ├─ transcribeClip ─────────────────────────────▶ TranscriptWord[]   (unchanged)
   ├─ probeClip ──────────────────────────────────▶ { durationS, w, h } (unchanged)
   └─ NEW: scene understanding
         │
         ▼
      detectScenes(exec, clipPath, durationS, opts)            (scenes.ts)
         │  1. ffmpeg select='gt(scene,T)',showinfo → stderr
         │  2. parseSceneCuts(stderr)        → cut timestamps      [PURE]
         │  3. buildWindows(cuts, duration)  → [{t0,t1}]           [PURE]
         │       • merge windows < MIN_SCENE_S
         │       • subdivide windows > SCENE_MAX_S
         │       • if count > SCENE_BUDGET: coarsen (raise min len, recompute) + log
         ▼
      SceneWindow[] {t0,t1}
         │
         ▼
      understandScenes(runner, exec, clipPath, windows)        (frameUnderstand.ts)
         │  for each window: seek midpoint (-ss), 1 frame → VLM → parseVlmResponse
         ▼
      Scene[] {t0,t1,caption,tags}
         │
         ▼
   buildClip(parts)                                            (assemble.ts)
         │  • clip.scenes = Scene[]
         │  • clip.caption = central scene's caption   (derived, free)
         │  • clip.tags    = union of scene tags (cap 8)
         ▼
   Clip  ── ClipLibrarySchema.parse ──▶ clips.json
         │
         ▼
   build_edl / search_clips  ─ describeClip renders scene lines with timestamps ─▶ agent
```

## Components

### `scenes.ts` (new)

- **`parseSceneCuts(stderr: string): number[]`** — PURE. Extracts `pts_time:` values from
  ffmpeg `showinfo` output → sorted, de-duped cut timestamps. Unit-tested with a captured
  stderr fixture; no ffmpeg.
- **`buildWindows(cuts: number[], durationS: number, opts): SceneWindow[]`** — PURE. Turns
  cut points + clip duration into contiguous `{t0,t1}` windows covering `[0, duration]`,
  then applies merge (`MIN_SCENE_S`) → subdivide (`SCENE_MAX_S`) → coarsen-on-budget. The
  whole granularity policy lives here and is exhaustively unit-tested.
- **`detectScenes(exec, clipPath, durationS, opts): Promise<SceneWindow[]>`** — the only I/O:
  runs ffmpeg via the injected `exec`, then `parseSceneCuts` → `buildWindows`. Short clip
  (no cuts, `duration ≤ SCENE_MAX_S`) → one window `[0, duration]`.

### `frameUnderstand.ts` (extended)

- **`sampleFrameAt(exec, clipPath, atS): Promise<string>`** — one JPEG data URI at a precise
  timestamp (`-ss atS -frames:v 1`). Reuses the existing JPEG/base64 handling.
- **`understandScenes(runner, exec, clipPath, windows): Promise<Scene[]>`** — for each window,
  sample its midpoint frame, caption via the existing VLM call + `parseVlmResponse`, attach
  the window's `t0/t1`. Empty windows → skip. Existing `understandFrames` stays for the
  single-frame path / tests.

### `types.ts` (additive)

```ts
export const SceneSchema = z.object({
  t0: z.number().nonnegative(),
  t1: z.number().nonnegative(),
  caption: z.string(),
  tags: z.array(z.string()),
});
export type Scene = z.infer<typeof SceneSchema>;
// ClipSchema gains:  scenes: z.array(SceneSchema).optional()
```

### `assemble.ts`

`ClipParts` gains `scenes: Scene[]`. `buildClip` writes `scenes` and derives the whole-clip
`caption` (the scene covering the clip's temporal midpoint) and `tags` (union of all scene
tags, cap 8). When `scenes.length <= 1`, behavior is identical to today.

### `builder/prompt.ts` + `tools.ts`

`describeClip` appends timed scene lines when `clip.scenes` has >1 entry:

```
- id=vlog1 | duration=62s | tags=[...] | caption="..." | scenes:
    3.0–9.5s: "unboxing the camera on a desk" [product, indoor]
    24.0–31.0s: "walking outside reviewing footage" [outdoor, b-roll]
```

`search_clips` includes the same scene summary in its text output. This is the payoff: the
agent now picks `in: 24, out: 31` knowing what is there.

## Data flow & backward compatibility

- A `clips.json` produced **before** this change has no `scenes` field → still validates
  (optional) → `describeClip` falls back to the whole-clip caption exactly as today.
- A single-scene clip produced **after** this change has one `scenes` entry; the whole-clip
  `caption` equals that scene's caption → no behavior change for short clips.
- Only multi-scene clips change what the agent sees — strictly additive information.

## Error handling

- **ffmpeg scene detection fails / returns nothing** → fall back to a single whole-clip
  window `[0, duration]` (current behavior). Never fail the clip on detection error.
- **A scene's frame sample or VLM call fails** → that scene degrades to an empty
  caption/tags (mirrors the existing "non-conforming VLM → empty" tolerance); the clip and
  its other scenes still publish.
- **Budget coarsening** → `log()` the original vs. coarsened scene count so truncation can
  never masquerade as full coverage.
- **Non-positive duration** → already fails loud in `buildClip`; unchanged.

## Testing

- **`parseSceneCuts`** — captured `showinfo` stderr fixture → expected timestamps; empty/garbled input → `[]`.
- **`buildWindows`** — the granularity policy: contiguous coverage of `[0,duration]`; merge
  of sub-`MIN_SCENE_S` cuts; subdivision of >`SCENE_MAX_S` windows; coarsen path when count
  exceeds `SCENE_BUDGET` (still full coverage, fewer windows); short-clip single-window case.
- **`understandScenes`** — fake `exec` + fake `runner`: N windows → N captioned scenes;
  per-scene VLM failure → empty caption, others intact.
- **`buildClip`** — scene passthrough; derived whole-clip caption/tags; single-scene parity
  with today.
- **`describeClip`** — emits scene lines (with timestamps) when >1 scene; falls back cleanly
  when `scenes` absent.
- **Schema back-compat** — an existing fixture without `scenes` still parses; a fixture with
  `scenes` parses and round-trips through `clips.json`.
- **Integration (gated)** — extend the existing preprocess integration test to assert the
  generated library's clips carry a non-empty `scenes` array for a multi-scene sample.

## Acceptance

A multi-scene source clip, run through preprocess, produces a `clips.json` whose entry has a
`scenes` array of `{t0,t1,caption,tags}` covering the clip end-to-end; the builder prompt for
that clip lists the timed scene captions; and an existing scene-less `clips.json` still
validates and drives the builder unchanged.
