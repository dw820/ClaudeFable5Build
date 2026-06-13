# Preprocess Scene-Level Visual Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make preprocess detect scenes within each source clip and caption each one, then surface those timed captions to the editing agent so it can pick segment in/out points by content.

**Architecture:** A new pure-core `scenes.ts` (ffmpeg scene detection → cut timestamps → window math) feeds a new `understandScenes` in `frameUnderstand.ts` (one midpoint frame per window → VLM). `assemble.ts` carries the resulting `Scene[]` onto each `Clip` (additive optional field on the frozen schema) and derives the whole-clip caption/tags for free. `builder/prompt.ts` and `agent/tools.ts` render timed scene lines so `build_edl`/`search_clips` see them.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, ffmpeg/ffprobe via an injected `ExecFn`, Replicate VLM via an injected `ReplicateRunner`, Zod schemas.

**Spec:** `docs/superpowers/specs/2026-06-13-preprocess-scene-understanding-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/loop/types.ts` | Modify | Add `SceneSchema`/`Scene`; add optional `scenes` to `ClipSchema`. |
| `src/preprocess/constants.ts` | Modify | Add the four env-overridable scene knobs. |
| `src/preprocess/scenes.ts` | Create | Pure `parseSceneCuts`, `buildWindows`, `applyBudget`; I/O `detectScenes`. |
| `src/preprocess/scenes.test.ts` | Create | Unit tests for the pure scene functions. |
| `src/preprocess/frameUnderstand.ts` | Modify | Add `sampleFrameAt` + `understandScenes`. |
| `src/preprocess/assemble.ts` | Modify | `ClipParts.scenes`; `buildClip` writes scenes + derives caption/tags. |
| `src/builder/prompt.ts` | Modify | `describeClip` appends timed scene lines. |
| `src/agent/tools.ts` | Modify | `search_clips` appends scene summary. |
| `src/preprocess/cli.ts` | Modify | Wire `detectScenes` + `understandScenes` into `preprocessClip`. |
| `src/preprocess/preprocess.test.ts` | Modify | Tests for `understandScenes` + `buildClip` scene behavior. |
| `src/builder/build.test.ts` | Modify | Test `describeClip` scene lines. |
| `src/agent/tools.test.ts` | Modify | Test `search_clips` scene summary. |

**Conventions to follow (already in this codebase):**
- ESM: every relative import ends in `.js` (e.g. `import { x } from "./scenes.js"`).
- Pure functions are separated from I/O and tested without ffmpeg/network.
- `ExecFn = (cmd, args) => Promise<{ stdout, stderr }>` is injected (see `frameUnderstand.ts:24`).
- Run a single test file with: `npx vitest run <path>`.

---

## Task 1: Scene schema (additive, backward-compatible)

**Files:**
- Modify: `src/loop/types.ts` (after `TranscriptWordSchema`, before/around `ClipSchema` at lines 13–31)
- Test: `src/preprocess/preprocess.test.ts` (new `describe("scene schema")` block)

- [ ] **Step 1: Write the failing test**

Add to `src/preprocess/preprocess.test.ts` (and add `ClipSchema` + `SceneSchema` to the existing `../loop/types.js` import at the top):

```ts
import { ClipLibrarySchema, ClipSchema, SceneSchema } from "../loop/types.js";

describe("scene schema", () => {
  it("validates a Scene", () => {
    const ok = SceneSchema.safeParse({ t0: 0, t1: 3, caption: "x", tags: ["a"] });
    expect(ok.success).toBe(true);
  });

  it("accepts a Clip WITHOUT scenes (backward compatible)", () => {
    const clip = {
      id: "c01", src: "a.mp4", start: 0, end: 12, duration: 12,
      resolution: [1080, 1920], transcript: [], caption: "x", tags: [],
    };
    expect(ClipSchema.safeParse(clip).success).toBe(true);
  });

  it("accepts a Clip WITH scenes", () => {
    const clip = {
      id: "c01", src: "a.mp4", start: 0, end: 12, duration: 12,
      resolution: [1080, 1920], transcript: [], caption: "x", tags: [],
      scenes: [{ t0: 0, t1: 6, caption: "first", tags: ["a"] }],
    };
    expect(ClipSchema.safeParse(clip).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "scene schema"`
Expected: FAIL — `SceneSchema` is not exported from `../loop/types.js`.

- [ ] **Step 3: Add the schema**

In `src/loop/types.ts`, after the `TranscriptWord` type (line 18) add:

```ts
export const SceneSchema = z.object({
  t0: z.number().nonnegative(),
  t1: z.number().nonnegative(),
  caption: z.string(),
  tags: z.array(z.string()),
});
export type Scene = z.infer<typeof SceneSchema>;
```

Then add one line to `ClipSchema` (inside the `z.object({ ... })`, after `tags: z.array(z.string()),` on line 29):

```ts
  scenes: z.array(SceneSchema).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "scene schema"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/loop/types.ts src/preprocess/preprocess.test.ts
git commit -m "feat(types): additive optional scenes[] on Clip contract"
```

---

## Task 2: Scene knobs

**Files:**
- Modify: `src/preprocess/constants.ts`

- [ ] **Step 1: Add the constants**

Append to `src/preprocess/constants.ts`:

```ts
/** ffmpeg `scene` score above which a frame is treated as a cut (0..1). */
export const SCENE_THRESHOLD = Number(process.env.SCENE_THRESHOLD ?? 0.4);

/** Cuts closer than this (seconds) merge — granularity floor / debounce. */
export const MIN_SCENE_S = Number(process.env.MIN_SCENE_S ?? 2);

/** Windows longer than this (seconds) are subdivided — long-take backstop. */
export const SCENE_MAX_S = Number(process.env.SCENE_MAX_S ?? 15);

/** Max VLM calls per clip before coverage coarsens (never truncates). */
export const SCENE_BUDGET = Number(process.env.SCENE_BUDGET ?? 60);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/preprocess/constants.ts
git commit -m "feat(preprocess): scene-detection knobs (env-overridable)"
```

---

## Task 3: `parseSceneCuts` (pure)

**Files:**
- Create: `src/preprocess/scenes.ts`
- Test: `src/preprocess/scenes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/preprocess/scenes.test.ts`:

```ts
/**
 * Unit suite for scene detection. Pure parts only — no ffmpeg.
 */
import { describe, it, expect } from "vitest";
import { parseSceneCuts } from "./scenes.js";

describe("parseSceneCuts", () => {
  it("extracts sorted, de-duped pts_time values from showinfo stderr", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1] n:0 pts:73080 pts_time:3.045 pos:1",
      "[Parsed_showinfo_1 @ 0x1] n:1 pts:228288 pts_time:9.512 pos:2",
      "[Parsed_showinfo_1 @ 0x1] n:2 pts:228288 pts_time:9.512 pos:2",
    ].join("\n");
    expect(parseSceneCuts(stderr)).toEqual([3.045, 9.512]);
  });

  it("returns [] for empty or non-matching input", () => {
    expect(parseSceneCuts("")).toEqual([]);
    expect(parseSceneCuts("no timestamps here")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "parseSceneCuts"`
Expected: FAIL — cannot find `./scenes.js`.

- [ ] **Step 3: Create the module with `parseSceneCuts`**

Create `src/preprocess/scenes.ts`:

```ts
/**
 * Scene detection for the offline preprocess pipeline.
 *
 * Pixel-difference scene detection (ffmpeg `select='gt(scene,T)'`) finds hard
 * cuts; the cadence ceiling (SCENE_MAX_S) backstops soft transitions it misses,
 * the floor (MIN_SCENE_S) debounces false positives, and a per-clip budget
 * coarsens (never truncates) on degenerate input.
 *
 * Pure core (`parseSceneCuts`, `buildWindows`, `applyBudget`) is split from the
 * single ffmpeg call (`detectScenes`) so it unit-tests with no ffmpeg.
 */
import type { ExecFn } from "./frameUnderstand.js";
import { SCENE_THRESHOLD, MIN_SCENE_S, SCENE_MAX_S, SCENE_BUDGET } from "./constants.js";

/** A half-open time window `[t0, t1)` within a clip, in seconds. */
export interface SceneWindow {
  t0: number;
  t1: number;
}

/** PURE: extract sorted, de-duped `pts_time` cut timestamps from ffmpeg showinfo stderr. */
export function parseSceneCuts(stderr: string): number[] {
  const times = new Set<number>();
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) times.add(t);
  }
  return [...times].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "parseSceneCuts"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/scenes.ts src/preprocess/scenes.test.ts
git commit -m "feat(preprocess): parseSceneCuts — showinfo stderr → cut timestamps"
```

---

## Task 4: `buildWindows` (pure: merge + subdivide)

**Files:**
- Modify: `src/preprocess/scenes.ts`
- Test: `src/preprocess/scenes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/scenes.test.ts` (extend the import to `import { parseSceneCuts, buildWindows } from "./scenes.js";`):

```ts
describe("buildWindows", () => {
  const opts = { minSceneS: 2, maxSceneS: 15 };

  it("turns cuts into contiguous windows covering [0, duration]", () => {
    const w = buildWindows([3, 9], 12, opts);
    expect(w).toEqual([
      { t0: 0, t1: 3 },
      { t0: 3, t1: 9 },
      { t0: 9, t1: 12 },
    ]);
  });

  it("merges windows shorter than minSceneS into the previous one", () => {
    // cut at 1s makes a 0–1 window (1s < 2s) → merged forward into 0–4
    const w = buildWindows([1, 4], 10, opts);
    expect(w).toEqual([
      { t0: 0, t1: 4 },
      { t0: 4, t1: 10 },
    ]);
  });

  it("subdivides windows longer than maxSceneS into equal sub-windows", () => {
    const w = buildWindows([], 30, opts); // one 0–30 window, max 15 → two 15s windows
    expect(w).toEqual([
      { t0: 0, t1: 15 },
      { t0: 15, t1: 30 },
    ]);
  });

  it("returns a single whole-clip window for a short clip with no cuts", () => {
    expect(buildWindows([], 8, opts)).toEqual([{ t0: 0, t1: 8 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "buildWindows"`
Expected: FAIL — `buildWindows` is not exported.

- [ ] **Step 3: Implement `buildWindows`**

Append to `src/preprocess/scenes.ts`:

```ts
export interface WindowOptions {
  minSceneS: number;
  maxSceneS: number;
}

/**
 * PURE: cuts + duration → contiguous windows covering `[0, duration]`, then
 * merge (sub-`minSceneS` windows fold into the previous, or into the next if
 * they are first) and subdivide (windows over `maxSceneS` split into equal
 * sub-windows). Defends against a non-positive duration by returning [].
 */
export function buildWindows(cuts: number[], durationS: number, opts: WindowOptions): SceneWindow[] {
  if (!(durationS > 0)) return [];

  // 1. Boundaries → raw contiguous windows.
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < durationS), durationS];
  const raw: SceneWindow[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) raw.push({ t0: bounds[i]!, t1: bounds[i + 1]! });

  // 2. Merge windows shorter than the floor.
  const merged: SceneWindow[] = [];
  for (const w of raw) {
    const prev = merged[merged.length - 1];
    if (w.t1 - w.t0 < opts.minSceneS && prev) {
      prev.t1 = w.t1; // fold into previous
    } else if (w.t1 - w.t0 < opts.minSceneS && merged.length === 0) {
      merged.push({ ...w }); // first window short: keep, next short one folds in
    } else {
      merged.push({ ...w });
    }
  }
  // A short FIRST window left over (no following window absorbed it) folds forward.
  if (merged.length >= 2 && merged[0]!.t1 - merged[0]!.t0 < opts.minSceneS) {
    merged[1]!.t0 = merged[0]!.t0;
    merged.shift();
  }

  // 3. Subdivide windows longer than the ceiling into equal sub-windows.
  const out: SceneWindow[] = [];
  for (const w of merged) {
    const len = w.t1 - w.t0;
    if (len > opts.maxSceneS) {
      const n = Math.ceil(len / opts.maxSceneS);
      const step = len / n;
      for (let i = 0; i < n; i++) {
        out.push({ t0: w.t0 + i * step, t1: i === n - 1 ? w.t1 : w.t0 + (i + 1) * step });
      }
    } else {
      out.push(w);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "buildWindows"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/scenes.ts src/preprocess/scenes.test.ts
git commit -m "feat(preprocess): buildWindows — merge floor + subdivide ceiling"
```

---

## Task 5: `applyBudget` (pure: coarsen, never truncate)

**Files:**
- Modify: `src/preprocess/scenes.ts`
- Test: `src/preprocess/scenes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/scenes.test.ts` (extend import to include `applyBudget`):

```ts
describe("applyBudget", () => {
  it("passes windows through unchanged when within budget", () => {
    const w = [{ t0: 0, t1: 5 }, { t0: 5, t1: 10 }];
    expect(applyBudget(w, 10, 8)).toEqual({ windows: w, coarsened: false });
  });

  it("coarsens to exactly `budget` equal windows covering the whole clip when over", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ t0: i, t1: i + 1 }));
    const { windows, coarsened } = applyBudget(many, 20, 4);
    expect(coarsened).toBe(true);
    expect(windows).toEqual([
      { t0: 0, t1: 5 },
      { t0: 5, t1: 10 },
      { t0: 10, t1: 15 },
      { t0: 15, t1: 20 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "applyBudget"`
Expected: FAIL — `applyBudget` is not exported.

- [ ] **Step 3: Implement `applyBudget`**

Append to `src/preprocess/scenes.ts`:

```ts
/**
 * PURE: bound VLM cost without dropping coverage. If more windows than `budget`,
 * replace them with exactly `budget` equal windows spanning `[0, durationS]` —
 * the whole clip stays covered end-to-end, only granularity coarsens. This only
 * triggers on degenerate input (strobe / heavy handheld).
 */
export function applyBudget(
  windows: SceneWindow[],
  durationS: number,
  budget: number,
): { windows: SceneWindow[]; coarsened: boolean } {
  if (windows.length <= budget) return { windows, coarsened: false };
  const step = durationS / budget;
  const coarse: SceneWindow[] = [];
  for (let i = 0; i < budget; i++) {
    coarse.push({ t0: i * step, t1: i === budget - 1 ? durationS : (i + 1) * step });
  }
  return { windows: coarse, coarsened: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "applyBudget"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/scenes.ts src/preprocess/scenes.test.ts
git commit -m "feat(preprocess): applyBudget — coarsen on degenerate input, never truncate"
```

---

## Task 6: `detectScenes` (the single ffmpeg call)

**Files:**
- Modify: `src/preprocess/scenes.ts`
- Test: `src/preprocess/scenes.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/scenes.test.ts` (extend import to include `detectScenes`; add `import type { ExecFn } from "./frameUnderstand.js";`):

```ts
describe("detectScenes", () => {
  const showinfo = "[Parsed_showinfo_1 @ 0x1] n:0 pts_time:5.0 pos:1";

  it("runs ffmpeg, parses cuts, and builds budgeted windows", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: showinfo });
    const windows = await detectScenes(exec, "clip.mp4", 12, {
      threshold: 0.4, minSceneS: 2, maxSceneS: 15, budget: 60,
    });
    expect(windows).toEqual([{ t0: 0, t1: 5 }, { t0: 5, t1: 12 }]);
  });

  it("falls back to a single whole-clip window when ffmpeg throws", async () => {
    const exec: ExecFn = async () => { throw new Error("ffmpeg missing"); };
    const windows = await detectScenes(exec, "clip.mp4", 9, {
      threshold: 0.4, minSceneS: 2, maxSceneS: 15, budget: 60,
    });
    expect(windows).toEqual([{ t0: 0, t1: 9 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "detectScenes"`
Expected: FAIL — `detectScenes` is not exported.

- [ ] **Step 3: Implement `detectScenes`**

Append to `src/preprocess/scenes.ts`:

```ts
export interface DetectOptions {
  threshold: number;
  minSceneS: number;
  maxSceneS: number;
  budget: number;
}

/** Default detect options sourced from the env-overridable constants. */
export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  threshold: SCENE_THRESHOLD,
  minSceneS: MIN_SCENE_S,
  maxSceneS: SCENE_MAX_S,
  budget: SCENE_BUDGET,
};

/**
 * Detect scene windows for one clip. The only I/O: one ffmpeg pass whose
 * showinfo lines go to stderr (the `null` muxer discards the video). Any ffmpeg
 * failure degrades to a single whole-clip window — detection is best-effort and
 * never fails the clip.
 */
export async function detectScenes(
  exec: ExecFn,
  clipPath: string,
  durationS: number,
  opts: DetectOptions = DEFAULT_DETECT_OPTIONS,
): Promise<SceneWindow[]> {
  const whole: SceneWindow[] = durationS > 0 ? [{ t0: 0, t1: durationS }] : [];
  try {
    const { stderr } = await exec("ffmpeg", [
      "-i", clipPath,
      "-filter:v", `select='gt(scene,${opts.threshold})',showinfo`,
      "-f", "null", "-",
    ]);
    const cuts = parseSceneCuts(stderr);
    const windows = buildWindows(cuts, durationS, opts);
    if (windows.length === 0) return whole;
    const { windows: bounded, coarsened } = applyBudget(windows, durationS, opts.budget);
    if (coarsened) {
      // eslint-disable-next-line no-console
      console.log(
        `[scenes] ${clipPath}: ${windows.length} scenes > budget ${opts.budget} — coarsened to ${bounded.length}`,
      );
    }
    return bounded;
  } catch {
    return whole;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/scenes.test.ts -t "detectScenes"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/scenes.ts src/preprocess/scenes.test.ts
git commit -m "feat(preprocess): detectScenes — ffmpeg pass with whole-clip fallback"
```

---

## Task 7: `sampleFrameAt` + `understandScenes`

**Files:**
- Modify: `src/preprocess/frameUnderstand.ts`
- Test: `src/preprocess/preprocess.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/preprocess.test.ts`. Extend the `./frameUnderstand.js` import to also import `understandScenes`, and the `./replicateClient.js` usage already provides `FakeReplicateRunner`. Add:

```ts
import { understandScenes } from "./frameUnderstand.js";
import type { ExecFn } from "./frameUnderstand.js";

describe("understandScenes", () => {
  // Minimal valid 1x1 JPEG byte stream (SOI…EOI) so splitJpegs finds one frame.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("binary");
  const fakeExec: ExecFn = async () => ({ stdout: jpeg, stderr: "" });

  it("captions each window from its midpoint frame", async () => {
    const runner = new FakeReplicateRunner([
      '{"caption":"first scene","tags":["a"]}',
      '{"caption":"second scene","tags":["b"]}',
    ]);
    const scenes = await understandScenes(runner, fakeExec, "clip.mp4", [
      { t0: 0, t1: 6 },
      { t0: 6, t1: 12 },
    ]);
    expect(scenes).toEqual([
      { t0: 0, t1: 6, caption: "first scene", tags: ["a"] },
      { t0: 6, t1: 12, caption: "second scene", tags: ["b"] },
    ]);
    // seeked to each window midpoint (3s, 9s)
    expect(runner.seenCalls).toHaveLength(2);
  });

  it("degrades a failing scene to an empty caption without dropping others", async () => {
    const runner = new FakeReplicateRunner((_id, _input, call) => {
      if (call === 0) throw new Error("VLM 500");
      return '{"caption":"ok","tags":[]}';
    });
    const scenes = await understandScenes(runner, fakeExec, "clip.mp4", [
      { t0: 0, t1: 6 },
      { t0: 6, t1: 12 },
    ]);
    expect(scenes[0]).toEqual({ t0: 0, t1: 6, caption: "", tags: [] });
    expect(scenes[1]).toEqual({ t0: 6, t1: 12, caption: "ok", tags: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "understandScenes"`
Expected: FAIL — `understandScenes` is not exported.

- [ ] **Step 3: Implement `sampleFrameAt` + `understandScenes`**

In `src/preprocess/frameUnderstand.ts`, add the `Scene` type import at the top (after the existing imports on lines 15–16):

```ts
import type { Scene } from "../loop/types.js";
```

Then append at the end of the file:

```ts
/**
 * Extract a single JPEG frame at a precise timestamp as a base64 data URI.
 * `-ss` before `-i` is a fast keyframe-accurate seek; `-frames:v 1` takes one
 * frame. Reuses the same MJPEG-split path as the sampler.
 */
export async function sampleFrameAt(exec: ExecFn, clipPath: string, atS: number): Promise<string | null> {
  const { stdout } = await exec("ffmpeg", [
    "-ss", String(atS),
    "-i", clipPath,
    "-frames:v", "1",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ]);
  const buf = Buffer.from(stdout, "binary");
  const [frame] = splitJpegs(buf);
  return frame ? `data:image/jpeg;base64,${frame.toString("base64")}` : null;
}

/**
 * Caption each scene window from its midpoint frame. Sequential so test runners
 * with call-indexed fakes are deterministic; the per-clip fan-out in cli.ts
 * already runs clips in parallel. A failed frame/VLM call degrades that one
 * scene to an empty caption rather than failing the whole clip.
 */
export async function understandScenes(
  runner: ReplicateRunner,
  exec: ExecFn,
  clipPath: string,
  windows: { t0: number; t1: number }[],
  opts: { model?: `${string}/${string}` | `${string}/${string}:${string}` } = {},
): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const w of windows) {
    try {
      const frame = await sampleFrameAt(exec, clipPath, (w.t0 + w.t1) / 2);
      if (!frame) {
        scenes.push({ t0: w.t0, t1: w.t1, caption: "", tags: [] });
        continue;
      }
      const response = await runner.run(opts.model ?? VLM_MODEL, { input: vlmInput(frame) });
      const { caption, tags } = parseVlmResponse(response);
      scenes.push({ t0: w.t0, t1: w.t1, caption, tags });
    } catch {
      scenes.push({ t0: w.t0, t1: w.t1, caption: "", tags: [] });
    }
  }
  return scenes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "understandScenes"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/frameUnderstand.ts src/preprocess/preprocess.test.ts
git commit -m "feat(preprocess): understandScenes — midpoint frame caption per window"
```

---

## Task 8: `assemble` carries scenes + derives the clip summary

**Files:**
- Modify: `src/preprocess/assemble.ts` (lines 54–87: `ClipParts`, `buildClip`)
- Test: `src/preprocess/preprocess.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/preprocess/preprocess.test.ts` inside the existing `describe("assemble")` block:

```ts
  it("attaches scenes and derives caption from the midpoint scene + union tags", () => {
    const clip = buildClip(
      partFixture({
        caption: "", tags: [],
        scenes: [
          { t0: 0, t1: 4, caption: "intro on the beach", tags: ["intro", "ocean"] },
          { t0: 4, t1: 12, caption: "the wipeout", tags: ["action", "ocean"] },
        ],
      }),
    );
    expect(clip.scenes).toHaveLength(2);
    // midpoint of a 12s clip is 6s → falls in the second window (4–12)
    expect(clip.caption).toBe("the wipeout");
    expect(clip.tags).toEqual(["intro", "ocean", "action"]); // union, de-duped, order-preserved
  });

  it("falls back to parts.caption/tags when there are no scenes (single-frame path)", () => {
    const clip = buildClip(partFixture({ caption: "single", tags: ["x"] }));
    expect(clip.scenes).toBeUndefined();
    expect(clip.caption).toBe("single");
    expect(clip.tags).toEqual(["x"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "assemble"`
Expected: FAIL — `partFixture` has no `scenes` field / `clip.scenes` is undefined when scenes provided.

- [ ] **Step 3: Implement**

In `src/preprocess/assemble.ts`:

(a) Add the `Scene` type to the import from `../loop/types.js` (line 38–42):

```ts
import {
  ClipLibrarySchema,
  type Clip,
  type ClipLibrary,
  type Scene,
  type TranscriptWordSchema,
} from "../loop/types.js";
```

(b) Add `scenes` to `ClipParts` (after `tags: string[];` at line 63):

```ts
  /** Per-scene captions from understandScenes; absent/empty for single-scene clips. */
  scenes?: Scene[];
```

(c) Add two pure helpers above `buildClip` (before line 71):

```ts
/** Caption of the scene covering the clip's temporal midpoint (deterministic). */
function captionAtMidpoint(scenes: Scene[], durationS: number): string {
  const mid = durationS / 2;
  const hit = scenes.find((s) => mid >= s.t0 && mid < s.t1) ?? scenes[0];
  return hit ? hit.caption : "";
}

/** De-duped union of all scene tags, order-preserved, capped. */
function unionTags(scenes: Scene[], max = 8): string[] {
  const seen = new Set<string>();
  for (const s of scenes) for (const t of s.tags) if (t !== "") seen.add(t);
  return [...seen].slice(0, max);
}
```

(d) Update `buildClip` to derive from scenes when present. Replace the `return { ... }` block (lines 76–86) with:

```ts
  const scenes = parts.scenes ?? [];
  const hasScenes = scenes.length > 0;
  return {
    id: parts.id,
    src: parts.src,
    start: 0,
    end: duration,
    duration,
    resolution: [parts.meta.width, parts.meta.height],
    transcript: parts.transcript,
    caption: hasScenes ? captionAtMidpoint(scenes, duration) : parts.caption,
    tags: hasScenes ? unionTags(scenes) : parts.tags,
    ...(hasScenes ? { scenes } : {}),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/preprocess/preprocess.test.ts -t "assemble"`
Expected: PASS (existing assemble tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/preprocess/assemble.ts src/preprocess/preprocess.test.ts
git commit -m "feat(preprocess): assemble carries scenes + derives clip summary"
```

---

## Task 9: Builder prompt surfaces timed scene lines

**Files:**
- Modify: `src/builder/prompt.ts` (lines 46–55: `describeClip`)
- Test: `src/builder/build.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/builder/build.test.ts` inside the `describe("buildPrompt (pure)")` block. The file already imports `buildPrompt`, `ClipLibrary`/`ClipLibrarySchema`, and has a `ctx(overrides)` helper that defaults `library` to the sample fixture (lines 26–46). Build a scenes-bearing library and pass it as a `ctx` override:

```ts
  it("renders timed scene lines when a clip has more than one scene", () => {
    const lib: ClipLibrary = ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 30, duration: 30,
        resolution: [1080, 1920], transcript: [], caption: "a vlog", tags: ["vlog"],
        scenes: [
          { t0: 0, t1: 9.5, caption: "unboxing on a desk", tags: ["product"] },
          { t0: 24, t1: 31, caption: "walking outside", tags: ["outdoor"] },
        ],
      }],
    });
    const prompt = buildPrompt(ctx({ library: lib }));
    expect(prompt.user).toContain("scenes:");
    expect(prompt.user).toContain('0.0–9.5s: "unboxing on a desk"');
    expect(prompt.user).toContain('24.0–31.0s: "walking outside"');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/builder/build.test.ts -t "timed scene lines"`
Expected: FAIL — the prompt contains no `scenes:` block.

- [ ] **Step 3: Implement**

In `src/builder/prompt.ts`, add a helper above `describeClip` (before line 46):

```ts
/** One-decimal second formatter for scene timecodes. */
const fmtS = (n: number): string => n.toFixed(1);

/** Timed scene lines for a clip, or "" when it has 0–1 scenes (no extra signal). */
function describeScenes(clip: Clip): string {
  if (!clip.scenes || clip.scenes.length <= 1) return "";
  const lines = clip.scenes.map(
    (s) => `    ${fmtS(s.t0)}–${fmtS(s.t1)}s: "${s.caption}" [${s.tags.join(", ")}]`,
  );
  return ` | scenes:\n${lines.join("\n")}`;
}
```

Then append `describeScenes(clip)` to the joined line in `describeClip` (line 48–54). Change the final `].join(" ")` so the scenes block is appended after it:

```ts
function describeClip(clip: Clip): string {
  return [
    `- id=${clip.id}`,
    `duration=${clip.duration}s`,
    `tags=[${clip.tags.join(", ")}]`,
    `caption="${clip.caption}"`,
    `transcript="${transcriptSnippet(clip)}"`,
  ].join(" ") + describeScenes(clip);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/builder/build.test.ts -t "timed scene lines"`
Expected: PASS. Also run the whole file to confirm no regression: `npx vitest run src/builder/build.test.ts` → all PASS (scene-less fixture clips are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/builder/prompt.ts src/builder/build.test.ts
git commit -m "feat(builder): surface timed scene captions to build_edl"
```

---

## Task 10: `search_clips` surfaces scene summary

**Files:**
- Modify: `src/agent/tools.ts` (lines 118–127: `search_clips` handler)
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/agent/tools.test.ts`. It already imports `EdlSchema` from `../loop/types.js`, `VIRAL_RUBRIC`/`SAMPLE_LIBRARY` from `../loop/stubs.js`, `makeStubToolImpls`/`createAutocutTools` from `./tools.js`, and `Tracker` from `./tracker.js`. Add `ClipLibrarySchema` to the `../loop/types.js` import, then add this test inside the `describe("createAutocutTools")` block (mirrors the existing `setup()` construction at lines 44–53):

```ts
  it("search_clips includes scene summaries when a clip has scenes", async () => {
    const library = ClipLibrarySchema.parse({
      projectId: "p",
      clips: [{
        id: "vlog1", src: "v.mp4", start: 0, end: 30, duration: 30,
        resolution: [1080, 1920], transcript: [], caption: "a vlog", tags: ["vlog"],
        scenes: [
          { t0: 0, t1: 9.5, caption: "unboxing on a desk", tags: ["product"] },
          { t0: 24, t1: 31, caption: "walking outside", tags: ["outdoor"] },
        ],
      }],
    });
    const tracker = new Tracker(VIRAL_RUBRIC);
    const { specs } = createAutocutTools({
      impls: makeStubToolImpls(),
      library,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: () => {},
    });
    const search = specs.find((s) => s.name === "search_clips")!;
    const res = await search.handler({ query: "anything" });
    expect(res.content[0]!.text).toContain("9.5s: unboxing on a desk");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/tools.test.ts -t "scene summaries"`
Expected: FAIL — the output has no scene line.

- [ ] **Step 3: Implement**

In `src/agent/tools.ts`, replace the `search_clips` handler return (line 125):

```ts
        return text(clips.map((c) => formatClipLine(c)).join("\n"));
```

And add a module-level helper near the top of the file (after the `text` helper on line 104):

```ts
/** One-decimal second formatter for scene timecodes. */
const fmtS = (n: number): string => n.toFixed(1);

/** `id: caption [tags]`, plus indented timed scene lines when the clip has scenes. */
function formatClipLine(c: Clip): string {
  const base = `${c.id}: ${c.caption} [${c.tags.join(", ")}]`;
  if (!c.scenes || c.scenes.length <= 1) return base;
  const scenes = c.scenes
    .map((s) => `\n    ${fmtS(s.t0)}–${fmtS(s.t1)}s: ${s.caption}`)
    .join("");
  return base + scenes;
}
```

(`Clip` is already imported in `tools.ts` at line 12–19.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/tools.test.ts -t "scene summaries"`
Expected: PASS. Run the full file to confirm no regression: `npx vitest run src/agent/tools.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat(agent): search_clips surfaces scene summaries"
```

---

## Task 11: Wire scene understanding into `preprocessClip`

**Files:**
- Modify: `src/preprocess/cli.ts` (lines 115–141: `preprocessClip`; imports at 31–35)
- Test: covered by `preprocess.test.ts` unit tests already; this task is the integration wiring.

- [ ] **Step 1: Add imports**

In `src/preprocess/cli.ts`, add to the imports block:

```ts
import { understandScenes } from "./frameUnderstand.js";
import { detectScenes } from "./scenes.js";
```

(`understandFrames` is currently imported on line 20–24; keep it — it stays available even though `preprocessClip` no longer calls it. If a linter flags it as unused, remove only `understandFrames` from that import, leaving `ffmpegFrameSampler`, `type ExecFn`.)

- [ ] **Step 2: Rewrite `preprocessClip` to detect + understand scenes**

Replace the body of `preprocessClip` (lines 122–140) with:

```ts
  const audio = new File([await readFile(absPath)], basename(absPath));
  const [transcript, meta] = await Promise.all([
    transcribeClip(runner, { audio }),
    probe(absPath),
  ]);
  // Scene detection needs the duration, so it runs after probe. Frame sampling
  // for scenes uses the binary-safe exec (JPEG bytes); detection uses the text
  // exec (showinfo on stderr).
  const windows = await detectScenes(execText, absPath, meta.durationS);
  const scenes = await understandScenes(runner, execBinary, absPath, windows);
  return {
    id: clipIdFromPath(absPath),
    src: relative(mediaDir, absPath),
    meta,
    transcript,
    // caption/tags are derived from scenes in buildClip; leave blanks here.
    caption: "",
    tags: [],
    scenes,
  };
```

Note: `preprocessClip`'s signature currently takes `sampler` (line 117). The scene path uses `execBinary`/`execText` directly, not `sampler`. Update the signature to drop `sampler` and add the two execs, OR keep `sampler` for the legacy single-frame path and add execs. **Chosen:** drop `sampler`, add `execText`/`execBinary` params so the function's dependencies are explicit and injectable:

```ts
export async function preprocessClip(
  runner: ReplicateRunner,
  execBinary: ExecFn,
  execText: ExecFn,
  probe: (path: string) => Promise<ClipMeta>,
  mediaDir: string,
  absPath: string,
): Promise<ClipParts> {
```

- [ ] **Step 3: Update the call site in `runDirectory`**

In `runDirectory` (lines 162–164), the current call passes `sampler`. Replace with the execs (both already defined in this file — `execBinary` at line 40, `execText` at line 86). Remove the now-unused `sampler` construction (line 150) if nothing else uses it:

```ts
  const parts = await Promise.all(
    files.map((f) => preprocessClip(runner, execBinary, execText, probeClip, mediaDir, f)),
  );
```

- [ ] **Step 4: Update the integration test call site**

`src/preprocess/preprocess.integration.test.ts` calls `preprocessClip(runner, sampler, probeClip, mediaDir, SAMPLE)` (around line 94). Update it to the new signature. The file already defines `execBinary` (line 40); add a text exec or reuse the binary one for stderr. Replace the call with:

```ts
      const execText: ExecFn = (cmd, args) =>
        new Promise((resolve, reject) => {
          const child = spawn(cmd, args);
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          child.stdout.on("data", (d: Buffer) => out.push(d));
          child.stderr.on("data", (d: Buffer) => err.push(d));
          child.on("error", reject);
          child.on("close", () =>
            resolve({ stdout: Buffer.concat(out).toString("binary"), stderr: Buffer.concat(err).toString("utf8") }),
          );
        });

      const parts = await preprocessClip(runner, execBinary, execText, probeClip, mediaDir, SAMPLE);
```

Also assert scenes are produced (after the existing assertions around line 104):

```ts
      expect(Array.isArray(library.clips[0]!.scenes)).toBe(true);
      expect(library.clips[0]!.scenes!.length).toBeGreaterThan(0);
```

- [ ] **Step 5: Run the unit suite + typecheck**

Run: `npx vitest run src/preprocess/preprocess.test.ts src/preprocess/scenes.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors (confirms every call site matches the new `preprocessClip` signature).

- [ ] **Step 6: Commit**

```bash
git add src/preprocess/cli.ts src/preprocess/preprocess.integration.test.ts
git commit -m "feat(preprocess): wire scene detection + understanding into preprocessClip"
```

---

## Task 12: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all PASS (integration tests gated by `REPLICATE_API_TOKEN`/`SUPABASE_*` skip cleanly when unset).

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Update the HTML walkthrough (optional, if keeping it accurate)**

`docs/preprocess-visual.html` Step 2 currently says "a few evenly-spaced frames" and shows a single image input. If you want it to match the new reality, update Step 2 to: "ffmpeg detects scene boundaries; one midpoint frame per scene is captioned" and the final `clips.json` example to include a `scenes` array on one clip. Not required for correctness — skip if out of scope.

- [ ] **Step 4: Final commit (if HTML updated)**

```bash
git add docs/preprocess-visual.html
git commit -m "docs: update preprocess visual for scene-level understanding"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** scene schema (T1), knobs (T2), detection mechanism + floor/ceiling/budget (T3–T6), midpoint captioning + per-scene failure tolerance (T7), additive scenes + derived summary + back-compat (T8), builder + search_clips surfacing (T9–T10), wiring + integration assertion (T11), deferred per-scene embeddings (not implemented, by design). All spec sections map to a task.
- **Back-compat is tested twice:** T1 (schema accepts scene-less clips) and T8 (buildClip falls back to parts.caption/tags); existing scene-less fixtures in `build.test.ts` must keep passing (T9 step 4).
- **Type consistency:** `SceneWindow {t0,t1}` (scenes.ts) vs `Scene {t0,t1,caption,tags}` (types.ts) are distinct on purpose — windows are pre-caption, scenes are post-caption. `understandScenes` consumes `SceneWindow[]`-shaped `{t0,t1}[]` and returns `Scene[]`.
- **`ExecFn` source:** imported from `./frameUnderstand.js` everywhere (its canonical export), including in `scenes.ts` — do not redefine it.
