# How Claude's work was orchestrated

This project has **two distinct loops**, and it helps to keep them apart:

1. **The development workflow** — how I (the human) directed Claude to *build* the system.
2. **The video editor agent's loop** — the autonomous runtime loop that *makes a video*.

They rhyme on purpose (plan → act → verify → correct, with judgment pushed into
artifacts rather than left to a model), but they operate at different layers. This
doc covers each in turn.

---

## Part 1 — Developing workflow (directing Claude to build it)

**Guiding principle: move judgment out of the model and into artifacts.** A
scope-locked brief, a machine-readable rubric, tested deterministic control code,
and reproducible scripts — so that as context grew or sessions reset, the source
of truth was a file, not the model's memory.

```
 CEO scope review            TDD increments              autonomous verify
 ───────────────             ──────────────              ────────────────
 /plan-ceo-review            spec.html ─▶ plan ─▶         daytona-provision
   (SCOPE REDUCTION)           failing test ─▶ code         + smoke-real-tools
        │                       ─▶ atomic commit                 │
        ▼                            │                           ▼
   prd.md §0 Scope Lock  ──────▶  git history          real ffmpeg / real LLM
   (binding, supersedes)         (one capability =      run on a clean sandbox
        │                         one tested commit)           │
        ▼                                                       ▼
   CLAUDE.md + memory  ◀──────── pinned facts that bit us (Opus 4.8 ≠ Fable 5)
```

### 1. A binding brief the agent re-reads — not a one-shot prompt
[`prd.md`](prd.md) is the contract. Its top section `## 0. Scope Lock` **explicitly
supersedes** the fuller vision below it, so whenever context got long there was one
authoritative, conflict-resolved spec to fall back on. The lock came out of a
`/plan-ceo-review` run in **SCOPE REDUCTION** mode (recorded in-file as *"Decisions
locked — 2026-06-12 CEO review"*), which produced the thesis *"the inner
self-correction loop is the product; everything else is supporting cast or
deferred"* and the Keep / Pre-bake / Cut / Defer table.

### 2. Pinned facts in scaffolding, not in the model's head
[`CLAUDE.md`](CLAUDE.md) and persistent memory carry the things that would silently
break a fresh session — most importantly *"runs on Opus 4.8, not Fable 5"*, which is
the entire reason the runtime loop has hard caps (see Part 2).

### 3. Design-spec → plan → tested increment
Each capability landed as: a visual design spec, then an implementation plan, then a
single tested commit. The git history is the receipt:

```
docs: scene-level preprocess visual understanding design spec
docs: implementation plan for scene-level preprocess understanding
feat(preprocess): parseSceneCuts — showinfo stderr → cut timestamps
feat(preprocess): buildWindows — merge floor + subdivide ceiling
feat(preprocess): applyBudget — coarsen on degenerate input, never truncate
```

TDD throughout — almost every module ships next to its `*.test.ts`
(`controller.test.ts`, `grade.test.ts`, `build.test.ts`, `cut.test.ts`, …).
Visual specs live in [`docs/`](docs/): [`loop-controller-spec.html`](docs/loop-controller-spec.html),
[`loop-vs-agent-spec.html`](docs/loop-vs-agent-spec.html),
[`architecture-flow.html`](docs/architecture-flow.html).

### 4. Reproducible "autonomous run" scaffolding
So that "autonomous" meant *reproducible*, not *lucky*:
- [`scripts/daytona-provision.ts`](scripts/daytona-provision.ts) + [`scripts/daytona-setup.sh`](scripts/daytona-setup.sh) — spin up a clean sandbox the agent runs in.
- [`scripts/smoke-real-tools.ts`](scripts/smoke-real-tools.ts) — exercise the real ffmpeg + real LLM path, not stubs.
- [`scripts/make-fixture.mjs`](scripts/make-fixture.mjs) + [`scripts/fetch-clips.mjs`](scripts/fetch-clips.mjs) — committed fixture clip library so tests never depend on live preprocessing.

### 5. Pre-bake the expensive, off-path work
Preprocessing ([`src/preprocess/`](src/preprocess/)) was built as first-class,
rerunnable modules (transcribe / frame-understanding / scene detection / embeddings)
but kept **off the live demo path** — a cached `clips.json` the agent reasons over —
so a slow VLM or transcription step can never kill the demo.

---

## Part 2 — The video editor agent's loop (runtime)

This is the product. The orchestration insight, straight from the
[`src/loop/controller.ts`](src/loop/controller.ts) header:

> *"The controller — not the agent — owns iteration, caps, and best-so-far. On
> Opus 4.8 we cannot trust the model to self-terminate cleanly, so termination
> lives in deterministic, tested code."*

```
   brief + rubric.json + clips.json
            │
            ▼
   ┌───────────────────┐   EDL    ┌──────────┐  render  ┌──────────────────────┐
   │  BUILDER agent     │ ───────▶ │  RENDER   │ ───────▶ │  VERIFIER agent       │
   │  (reads clips.json,│          │ ffmpeg cut│          │  (Lane C, independent │
   │   builds EDL)      │          │ +Remotion │          │   context)            │
   │  src/builder,      │          │  overlay  │          │  src/verify/grade.ts  │
   │   src/agent        │          │ [ffmpeg   │          │  sees ONLY frames +   │
   └───────────────────┘          │  fallback]│          │  rubric — NEVER the   │
            ▲                      └──────────┘          │  EDL                  │
            │                                            └──────────┬───────────┘
            │      feedback (per-dimension, keyed)                  │ JSON {scores, pass, feedback}
            │                                                       ▼
            │                                          ┌─────────────────────────┐
            └──────────── no, and no cap hit ───────── │  CONTROLLER (deterministic)│
                                                       │  caps: maxIters |          │
                                          pass ──ship──│  wallclockMs | tokenBudget │
                                                       │  always retains BEST-SO-FAR│
                                                       └─────────────┬─────────────┘
                                                                     │ on ship
                                                                     ▼
                                                       distill ONE rule → file memory
                                                       (src/memory) — learns across runs
```

### 1. The controller owns termination — not the agent
[`src/loop/controller.ts`](src/loop/controller.ts) runs `build → render → grade`,
loops on failure, and stops on the **first** of: `maxIters` (3–4), `wallclockMs`, or
`tokenBudget`. Critically it always keeps the **best-scoring render so far**, so on
cap exhaustion it ships best-so-far with *"passed N/5 dimensions, stopped at
iteration K"* — **never stalls, never ships nothing.** Builder / render / verify are
injected dependencies ([`src/loop/deps.ts`](src/loop/deps.ts)), so the loop is fully
unit-tested without ffmpeg or Claude ([`controller.test.ts`](src/loop/controller.test.ts),
[`integration.test.ts`](src/loop/integration.test.ts)). A stubbed, runnable proof of
termination lives in [`src/loop/demo.ts`](src/loop/demo.ts).

### 2. The builder agent
[`src/agent/`](src/agent/) + [`src/builder/`](src/builder/) — the agent reads
`clips.json` (with scene summaries + timed captions), searches/inspects clips via
tools, and emits a validated **EDL**. On a failing grade it receives the previous
feedback keyed by dimension and the previous EDL, and adjusts.

### 3. The independent verifier agent — the "not self-critique" proof
[`src/verify/grade.ts`](src/verify/grade.ts) is **Lane C**: a *fresh agent in
isolated context*. It extracts keyframes from the rendered video and scores them
against [`rubrics/viral-short.json`](rubrics/viral-short.json) — and it is
deliberately built **never to receive the EDL**:

> *"Independence: the prompt is built from rubric + frames only; this file never
> receives an EDL."*

So the grader judges the *artifact*, blind to the builder's intent. It returns
machine-checkable JSON (5 dimensions, pass iff every dimension ≥ `passThreshold` of
7), with reprompt-once-then-sentinel handling so a malformed grade can never wedge
the loop.

### 4. The rubric is the contract between the two agents
[`rubrics/viral-short.json`](rubrics/viral-short.json) — `hook_strength`,
`pace_cut_density`, `caption_legibility`, `loopability`, `on_style_trend_fit` — is
the shared, machine-readable interface. The builder optimizes toward it; the
verifier scores against it; neither needs to trust the other's prose.

### 5. Memory — learns across runs
After shipping, the agent distills **one** rule to file memory
([`src/memory/`](src/memory/) — `distill.ts` / `consult.ts`), consulted on the next
run. Cheap, but it's the "improves across sessions" proof.

---

## The short version

| | Developing workflow | Agent runtime loop |
|---|---|---|
| **Plan** | `/plan-ceo-review` → `prd.md` Scope Lock | builder agent reads brief + rubric + clips |
| **Act** | TDD: spec → plan → tested commit | render: ffmpeg cut + Remotion overlay (ffmpeg fallback) |
| **Verify** | smoke-real-tools on a Daytona sandbox | independent verifier agent grades frames vs rubric |
| **Correct** | atomic commits, pinned facts in CLAUDE.md | controller feeds feedback back, caps + best-so-far |
| **Source of truth** | `prd.md` / `CLAUDE.md` / rubric file | the rubric JSON + deterministic controller |

Both loops follow the same discipline: **judgment lives in artifacts and tested
code, not in a model's confidence.**

Key files — brief: [`prd.md`](prd.md) · rubric: [`rubrics/viral-short.json`](rubrics/viral-short.json) ·
controller: [`src/loop/controller.ts`](src/loop/controller.ts) · verifier:
[`src/verify/grade.ts`](src/verify/grade.ts) · scripts: [`scripts/`](scripts/).
