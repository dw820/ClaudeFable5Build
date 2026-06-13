# AutoCut — Autonomous AI Video Editor (PRD v0.1)

*Working title — rename freely.*

---

## 0. Scope Lock (v0.2 — Hackathon Demo)

> This section is the binding scope for Build Day and **supersedes** anything below it where they conflict. Sections 1–14 are retained as the fuller product vision; treat them as reference + post-demo roadmap.

**Decisions locked (2026-06-12 CEO review):**
- **Mode: SCOPE REDUCTION.** Ship the minimum that proves the thesis live. The inner self-correction loop is the product; everything else is supporting cast or deferred.
- **Model: Opus 4.8** (`claude-opus-4-8`). Fable 5 is unavailable. Tradeoff acknowledged: Build Day's Autonomy scoring is tuned to Fable 5's long-horizon edge, so the loop must be designed tightly (hard caps, best-so-far fallback) to keep Opus 4.8 finishing runs without hand-holding.
- **One style only:** Viral Short. Styles 2–3 deferred.
- **Social outer loop DEFERRED.** Real engagement can't pay off in a 2-minute live demo. Cross-session **memory** stays (cheap file write; proves "learns across runs" by persisting one distilled rubric rule).
- **Remotion KEPT** as the motion-graphics path, but with an **ffmpeg-burned-caption fallback** wired in so a failed/slow render still ships a captioned video.
- **Preprocessing pre-baked** into a cached `clips.json`, **but built as first-class modular code** (transcribe / frame-understanding / embeddings as independent, rerunnable modules). pgvector/embeddings module exists but is **off the demo path**; the agent reasons over `clips.json` directly (~10 curated clips).

### The Minimum Viable Demo Spine

```
/goal + Viral Short rubric (file)
  → agent reads clips.json, builds EDL
  → ffmpeg cut  (+ optional .cube LUT grade)
  → caption/overlay: Remotion template → [fallback: ffmpeg drawtext]
  → director verifier subagent (independent context) grades vs rubric → JSON {scores, pass, feedback}
  → pass? ship : agent reads feedback, adjusts EDL/overlays, re-runs
  → (cap: max 3–4 iters / token budget / wall-clock) → ship best-so-far
  → agent writes ONE distilled rule to file-memory
```

### Keep / Pre-bake / Cut / Defer

| Component | Verdict |
|---|---|
| Inner self-correction loop | **KEEP** — the whole product |
| Director verifier subagent (independent ctx) | **KEEP** — "not self-critique" proof |
| Viral Short rubric file (machine-checkable JSON) | **KEEP** |
| File memory (1 distilled rule) | **KEEP (light)** |
| ffmpeg cut | **KEEP** |
| Remotion overlay (1 tested template) + ffmpeg fallback | **KEEP, hardened** |
| Color grade (one `.cube` LUT) | **OPTIONAL** — keep only if ~free |
| Preprocessing (transcribe/VLM/embeddings) | **PRE-BAKE, build as modules** — never run live |
| pgvector vector search | **MODULE EXISTS, off demo path** — agent uses `clips.json` |
| Styles 2 & 3, social publish + engagement, Modal burst, full Supabase Realtime | **DEFER** (see §13) |

### Loop Termination (the #1 demo-killer — design explicitly)
- Hard caps: **max 3–4 self-correction iterations**, per-phase token budget, wall-clock cap.
- Always retain the **best-scoring render so far**.
- On cap exhaustion → ship best-so-far + surface "passed N/5 dimensions, stopped at iteration K." **Never stall, never ship nothing.**

### Rubric Design — Viral Short (verifier returns JSON, not prose)
```
{
  "hook_strength":      0-10,   // punch in first 2s
  "pace_cut_density":   0-10,
  "caption_legibility": 0-10,
  "loopability":        0-10,
  "on_style_trend_fit": 0-10,
  "pass": bool,                 // true iff every dimension >= 7
  "feedback": { "<failing_dim>": "actionable note" }
}
```
Per-dimension floor (≥7 each) beats a single aggregate score: harder to reward-hack, and it renders as a scorecard the judges watch climb each iteration. Verifier sees **only the rendered video + rubric file** — never the builder's EDL rationale.

### Demo Runbook (pre-warm checklist)
- Daytona workspace warm + Claude Code (Opus 4.8) already running.
- `clips.json` pre-generated from the curated clip library (preprocessing run earlier, offline).
- One Remotion template pre-built; a **test render verified**; ffmpeg-caption fallback tested.
- Seed a deliberately weak iteration-1 ordering so the verifier **fails it** and the self-correction is visible — the "agent caught its own mistake" money shot (Autonomy proof). Scripted but honest.
- **Recorded backup video** of a full successful run, in case live fails.

### UI surface (minimum for Demo score)
Stream agent steps (Agent SDK) + a **live rubric scorecard updating per iteration** + before/after video preview. That is the demo's visual spine. Full Supabase Realtime is optional polish.

### Codebase Modularity (per scope decision)
`preprocess/` (transcribe · frame_understand · embed — each independently runnable, output `clips.json` + optional pgvector), `loop/` (goal + iteration controller + caps), `verify/` (director subagent + rubric loader), `edit/` (ffmpeg cut + grade), `overlay/` (remotion + ffmpeg fallback), `memory/` (distill + consult). Modules stand alone so deferred pieces (pgvector, styles, social) slot in post-demo without a rewrite.

---

## 0b. Eng Architecture (locked — v0.2)

> Locked by `/plan-eng-review` (2026-06-12). Three core decisions: **(1)** a deterministic JS workflow controller owns the loop (not the agent via `/goal`); **(2)** the agent emits a schema-validated **JSON EDL** that a deterministic renderer compiles to ffmpeg (the agent never touches ffmpeg directly); **(3)** the controller writes step/score **events to Supabase**, the UI subscribes via Realtime (reconnection-safe + replayable).

### Architecture diagram

```
Browser — Next.js / Vercel AI SDK / shadcn
  Upload · Brief form · LIVE: agent steps + rubric scorecard + before/after player
     │ POST /api/generate                          ▲ Supabase Realtime (events + grades)
     ▼                                             │
  Next.js API route ── Agent SDK (headless) ──────►│
     ▼                                             │
  Daytona workspace — Claude Code · Opus 4.8       │
   ┌──────────────────────────────────────────┐    │
   │ loop/ controller  (dynamic workflow, JS)  │───►│ writes step/score rows
   │   caps: iters<=4 · token budget · wallclock│    │
   │   tracks best_render                       │    │
   │   per iteration:                           │    │
   │     builder agent → EDL (JSON, schema)     │    │
   │        └ reads clips.json                  │    │
   │     edit/ renderer: EDL → ffmpeg (+LUT)    │    │
   │     overlay/: Remotion template            │    │
   │        └ FALLBACK → ffmpeg drawtext        │    │
   │     verify/ director subagent (fresh ctx)  │    │
   │        └ sees video + rubric ONLY → grade  │    │
   │     pass? stop : feedback → builder        │    │
   │   on stop: ship best_render + memory rule  │    │
   │ memory/ distill + consult (files)          │    │
   └──────────────────────────────────────────┘    │
     ▼ Storage (renders, clips)                      │
  Supabase — Postgres · Storage · Realtime · Auth ───┘

OFF demo path (built, modular): preprocess/ (transcribe · frame_understand · embed
  → clips.json + optional pgvector)
```

### Module boundaries
`preprocess/` (transcribe · frame_understand · embed; offline) · `loop/` (controller + caps + best-so-far) · `verify/` (director subagent + rubric loader + grade parse) · `edit/` (EDL schema + ffmpeg renderer + LUT) · `overlay/` (Remotion template + ffmpeg-caption fallback; caption content/timing computed once, shared) · `memory/` (distill + consult) · `app/` (Next.js UI + `/api/generate`).

### Data contracts
**clips.json** (per project, produced offline by `preprocess/`):
```
{ "project_id", "clips":[ { "id","asset_id","src","start","end","duration",
  "resolution":[w,h], "transcript":[{"word","t0","t1"}], "caption","tags":[],
  "quality":{"sharpness","shake"} } ] }
```
**EDL** (builder output, schema-validated before any render):
```
{ "edl_id","aspect","target_len_s","lut":"x.cube|null",
  "segments":[ { "clip_id","in","out","transition":"cut|crossfade",
    "captions":[{"text","t0","t1","style"}] } ],
  "selection_rationale":"..." }
```
Schema rules: total duration within target ± tol · transition ∈ tested set · caption `t` within its segment · `clip_id` ∈ clips.json. Invalid EDL is rejected and bounced back to the builder (counts as an iteration).

**grade** (verifier output): `{ scores{5 dims}, pass, feedback{<dim>:note}, render_id }` — pass iff every dim ≥ 7.
**events** (Realtime UI): `{ project_id, run_id, iteration, phase, message, score_snapshot?, render_ref?, ts }`.

### Build order (demo-spine + riskiest-integration first)
1. **`loop/` controller + caps + best-so-far** — with STUB builder/render/verify returning canned data. Prove termination + Realtime events end-to-end with fakes on day 1. *(build task #1)*
2. **EDL schema + `edit/` renderer** (EDL→ffmpeg cut, +LUT) — unit-test compile + validation.
3. **`overlay/`** Remotion template + ffmpeg-caption fallback — verify a test render + test the fallback path.
4. **`verify/` director subagent** + rubric file + grade parse — wire real grading in.
5. **builder agent** (clips.json → EDL) — replace the stub; loop now real end-to-end.
6. **`preprocess/` modules** — run offline to produce the demo `clips.json`; pgvector optional/off-path.
7. **`memory/`** distill + consult (one rule).
8. **Next.js UI** — upload/brief + live steps + scorecard + player. Build against step-1 stub events in parallel.
9. **Demo runbook** — pre-warm, seed weak iter-1, record backup replay.

### Failure modes (critical path — no silent failures)
| Codepath | Failure | Handling | Test | User sees |
|---|---|---|---|---|
| controller | never converges | caps → ship best-so-far | unit | "passed N/5, iter K" |
| EDL validation | invalid EDL | reject → bounce to builder | unit | retry step logged |
| renderer | ffmpeg error/timeout | catch → fail iter, keep best | unit | render-fail step, loop continues |
| overlay | Remotion fail/slow | fallback → ffmpeg drawtext | unit | captioned video still ships |
| verifier | malformed JSON | parse + 1 reprompt, else fail-iter | unit | loop continues, not stalled |
| Agent SDK launch | headless launch fails | API error to UI; pre-warm mitigates | smoke | "couldn't start, retry" |
| Realtime | socket drop | events persisted; UI re-fetches | manual | feed catches up, no blank |

### Test coverage plan (100% on the deterministic core)
controller caps/best-so-far/termination [★★★] · EDL validator reject paths [★★★] · renderer compile + LUT + trim [★★] · overlay fallback produces a file [★★★ — demo safety net] · verifier parse + reprompt [★★] · memory distill/consult [★★] · `[→EVAL]` verifier sanity: 1 good cut passes, 1 weak cut fails [P2].

### NOT in scope (eng)
Live preprocessing on stage · pgvector on demo path · styles 2–3 · social/engagement · Modal · full auth (single pre-authed demo user) · multi-project concurrency.

### Parallelization (worktree lanes)
- **Lane A (spine):** steps 1 → 2 → 4 → 5 (shared loop/edit/verify, sequential).
- **Lane B (overlay):** step 3 — starts once EDL schema (step 2) is frozen.
- **Lane C (preprocess):** step 6 — fully independent; produces the clips.json fixture.
- **Lane D (UI):** step 8 — independent; builds against step-1 stub events.
- Order: A first (defines schemas) → freeze the EDL→render interface after step 2 → launch B, C, D in parallel. Conflict flag: keep the EDL/render interface frozen post-step-2 to avoid A/B churn.

---

## 0c. Demo UI — Locked Design

> Locked by `/plan-design-review` + `/design-shotgun` (2026-06-12). Approved mockup (interactive, build from this): `~/.gstack/projects/dw820-ClaudeFable5Build/designs/generation-theater-20260612/autocut-final.html`. Derived from the Claude Design handoff wireframe (`AutoCut Wireframes.dc.html`, generated from this PRD) rendered in an elegant warm-paper aesthetic.

### Aesthetic (design tokens)
- **Vibe:** warm editorial / "creative studio," elegant not slick. No gradients, no heavy rounding, no AI-slop card grids.
- **Type:** **Fraunces** (serif) for display headings + score/iteration labels; **Inter** for UI/body; uppercase tracked micro-labels (`letter-spacing .13em`, `--faint`).
- **Color:** bg `#E9E5DD` · card `#FBFAF7` · sink `#F3F1EA` · ink `#22211D` (text + selected) · muted `#6B6760` · hairline `#D8D3C8`. Accent **coral `#D64A43`** (primary actions only). Semantics: pass green `#2F8A4E`, fail red `#C0392B`, working amber `#9A6B1E`, memory blue `#2F5D99`.
- **Shape:** consistent radius 11–14px (no wobble). Soft offset shadow `3px 4px 0 rgba(34,33,29,.07)` for warmth + hairline borders. Pills: `--ink` solid when selected, hairline when not.

### Screens (3)
1. **Setup** — left: footage **library** (clip grid + `clips.json ready` note showing transcript/scene/embed indexed); right: **brief** (Style/Aspect pills, Length, Tone, Concept textarea, coral **Generate**).
2. **Generation** (the money screen — wireframe Layout A, **three-pane**):
   - **Left — Agent steps:** streamed labeled timeline (PLAN · MEMORY · SELECT · BUILD · RENDER · OVERLAY · VERIFY✕ · FIX · BUILD · VERIFY✓ · MEMORY), tag chips color-coded by phase.
   - **Center — Before/after preview:** small iter-1 (dim) → arrow → large current cut + scrubber; "↳ the agent caught its own miss" annotation on pass.
   - **Right — persistent Rubric scorecard rail:** 5 dimension bars (climb red→green), per-dim score, pass marker, verdict block (PASS/FAIL), and the iteration toggle. Caption: "verifier sees video + rubric only · caps ≤4 iters · best-so-far kept."
3. **After** — ship/publish card (final player + score summary + coral Publish, marked "deferred for demo") + engagement/memory card (stat tiles, retention curve w/ 2s-hook marker, learned memory rule). Engagement is the deferred outer loop, shown for narrative.

### Interaction states (the demo choreography)
`idle → running(iter N) → VERIFY fail (red, feedback shown) → self-correct → bars climb → VERIFY pass (green) → ship best-so-far`. On budget/iteration cap: ship best-so-far + "passed N/5, iter K." The iter-1→iter-2 toggle in the mockup is the literal money-shot.

### Build mapping (shadcn)
Scorecard bars = shadcn `Progress` (drive `value` from the grade JSON per iteration); verdict = `Badge`; pills = `ToggleGroup`; step feed + chat = a simple list fed by Supabase Realtime rows; before/after = `Tabs` over two `<video>`. Live data: controller writes `events`/`grades` rows → UI subscribes (per §0b D3). Realtime drives the exact state transitions above.

### Responsive / a11y (demo-scoped)
Desktop-first (demo is on a laptop/projector). Min targets 44px; score bars carry a text score + ✓/✕ mark (not color-only) so the climb reads without relying on hue; contrast ≥ 4.5:1 on body. Mobile is post-demo.

---

## 1. Context & Goal

**Problem.** End-to-end video editing — scripting, clip selection, cutting, color grading, motion graphics, and optimizing for engagement — is slow, skilled, and tool-heavy. Creators spend hours in timelines for every minute of output.

**Goal.** Put Claude **Opus 4.8** at the center of an autonomous pipeline that takes **raw video assets + a high-level brief** and produces a **finished, graded, motion-enhanced video** — selecting clips, editing with ffmpeg, color grading, overlaying Remotion motion graphics, and **grading its own output against a style rubric**, self-correcting in a loop until the rubric passes. It then publishes, reads real engagement data, and uses that as an **outer optimization signal**.

**Done looks like.** A user uploads a handful of raw clips, picks a style + aspect ratio + length, clicks generate, and — with minimal human intervention — receives a polished video that a director-grade verifier agent has scored as "ship-ready." The session log shows the agent caught and fixed its own mistakes.

**Non-goals (v1).** Frame-perfect 4K broadcast mastering; a manual timeline editor; multi-user collaboration; arbitrary platform support.

**Deferred for the hackathon demo (see §0 Scope Lock):** live social publish + engagement outer loop; styles beyond Viral Short; live preprocessing on stage; pgvector search on the demo path; Modal render burst; full Supabase Realtime. All retain a code home so they slot back post-demo.

## 2. Users & Use Cases

- **Solo creators / founders** turning raw footage into social-ready shorts without learning Premiere.
- **Social/growth teams** that want a self-optimizing content loop driven by real engagement.
- **The demo persona:** upload 5–10 raw clips → "Make me a 30s vertical viral short" → ship it → watch the agent iterate on the next cut using engagement data.

## 3. Core Philosophy — The Agent at the Center

Everything is built **around the agent's loop**, using Opus 4.8 with proven design-loop principles:

1. **Self-correction loop.** The agent runs against a `/goal` and a **style rubric**; a **verifier sub-agent** (independent context) grades the output; the agent reads the score, fixes, and re-runs until the rubric passes. No self-critique on its own output — grading is always a separate agent.
2. **Verifier sub-agents as "directors."** Each style has a rubric, and grading is done by an agent role-played as a domain expert (a film director, a viral-content producer, an explainer-video editor). Multiple lenses where a single score would miss failure modes.
3. **Memory as the outer loop.** Persistent file-based memory (on the Daytona workspace) spans sessions: the agent records what worked/failed (hooks, pacing, grades, engagement outcomes), verifies it, distills it into reusable rules, and consults it on the next job — fail → investigate → verify → distill → consult.
4. **Minimal human-in-the-loop.** Humans provide taste (the brief, the style) and approve at most one or two gates. The agent owns everything in between.

## 4. Key Features

1. **Ingest.** User uploads raw video assets.
2. **Preprocess & understand.** For each asset: transcribe (word-level timestamps), sample frames → caption/understand scene & on-screen content (VLM), tag, and embed content into vectors. Persist to the DB so the agent can search and reason over the library.
3. **Brief UI.** User specifies the video they want: style, aspect ratio, target length, tone, optional script/notes.
4. **Generate (the inner loop).** Opus 4.8 finds relevant clips (vector + transcript search), builds a JSON EDL, edits with **ffmpeg**, color-grades, and overlays dynamic motion graphics via **Remotion** — then a director verifier grades it and the agent self-corrects until the style rubric passes.
5. **Social self-improvement (the outer loop).** Publish to a connected platform, pull engagement metrics, and feed them back as an optimization signal to steer the next generation (hook, pacing, length, style).

## 5. High-Level Architecture

```
┌──────────────── Next.js (Vercel) — shadcn/ui + Tailwind ────────────────┐
│  Vercel AI SDK: agentic chat · streamed agent steps · tool-call view     │
│  Upload UI · Brief form · Live job progress (Supabase Realtime)          │
│  Preview player · Rubric/score view · Engagement dashboard               │
└───────────────┬──────────────────────────────────▲──────────────────────┘
                │ launch / monitor job             │ realtime status
                │ (Claude Agent SDK, headless)     │
                ▼                                  │
┌──────────────── Daytona workspace — the AGENT'S HOME ───────────────────┐
│  Claude Code harness — Opus 4.8 (claude-opus-4-8) = the brain           │
│   • dynamic workflows + subagents (fan-out)                             │
│   • file-based memory (persists across sessions)  ← outer loop          │
│   • /goal + style rubric → self-correction loop                        │
│                                                                         │
│  tool exec (same filesystem):                                          │
│   ingest · search_clips(vector+transcript) · build_edl                 │
│   ffmpeg_cut · color_grade(LUT) · remotion_render                      │
│   grade(rubric)=director verifier subagent · publish · read_metrics    │
│                                                                         │
│  workflows it runs:                                                     │
│   • preprocess N clips in parallel                                      │
│   • grading panel: multiple director rubrics in parallel               │
│  (optional: burst heavy render to Modal if throughput-bound)           │
└───────┬───────────────────────────┬──────────────────┬─────────────────┘
        ▼                           ▼                  ▼
   ┌──────────┐              ┌──────────────┐    ┌───────────────┐
   │ Replicate│              │  Supabase    │    │ Social API    │
   │ transcribe│             │  Postgres    │    │ publish +     │
   │ VLM frame │             │  +pgvector   │    │ metrics       │
   │ embeddings│             │  +Storage    │    │ (outer loop)  │
   └──────────┘              │  +Realtime   │    └───────────────┘
                             │  +Auth       │
                             └──────────────┘
```

**Component responsibilities**

- **Next.js + Vercel AI SDK + shadcn/Tailwind** — the agentic UI: chat, streamed agent steps, tool-call visualization, upload, brief form, realtime job progress, preview, score & engagement dashboards. Triggers and monitors backend agent runs.
- **Daytona workspace (Claude Code / Opus 4.8)** — the agent's persistent home. Runs the long-horizon autonomous loop, dynamic workflows + subagents, holds file-based memory, and executes ffmpeg/Remotion in its own filesystem. This is where the long-horizon edge lives.
- **Claude Agent SDK** — programmatic bridge: the Next.js backend uses it to launch/monitor headless agent runs on Daytona (or the Claude Code CLI directly).
- **Dynamic workflows** — saved scripts the agent runs for batch fan-out (parallel per-clip preprocessing; a parallel **grading panel** across director rubrics). The reusable orchestration artifact for judges.
- **Replicate** — hosted GPU models: transcription (word-timestamped), frame→text VLM (scene/screen understanding), content embeddings.
- **Supabase** — Postgres (projects, assets, clips, transcripts, EDLs, grades, engagement), pgvector (clip/content embeddings), Storage (raw + rendered video), Realtime (push job progress to UI), Auth.
- **Social API** — publish the rendered video and pull back engagement metrics for the outer loop.
- **Modal (optional)** — parallel render/encode burst if Daytona throughput becomes a bottleneck. Not in the core demo path.

## 6. Data Model (high level)

- `projects` — a user's editing project + brief (style, aspect, length, tone).
- `assets` — uploaded raw files (Storage refs, duration, resolution).
- `clips` — segments with transcript, frame captions, tags, **embedding** (pgvector), quality signals.
- `edls` — JSON Edit Decision List per generated cut: ordered clips, in/out points, transitions, LUT, overlays, and a stored `selection_rationale` per cut (inspectable, like the deck).
- `renders` — output video refs + render metadata.
- `grades` — verifier scores per rubric dimension + pass/fail + feedback (drives the loop).
- `engagement` — per-published-render metrics over time (outer-loop signal).
- `memory` — distilled cross-session rules (file-based on the Daytona workspace; index mirrored to DB for the UI).

## 7. The Agent Loops

**Inner loop (per generation) — self-correction against a rubric**
```
brief + style rubric (/goal)
  → search_clips → build_edl → ffmpeg_cut → color_grade → remotion_render
  → grade(rubric) via director verifier sub-agent (independent context)
  → pass? ship : read feedback, adjust EDL/grade/overlays, re-run
  (repeat until rubric passes or budget exhausted)
```

**Grading panel (fan-out, via workflow)** — for ambitious cuts, grade the same render in parallel against several lenses (storytelling, hook strength, pacing, visual/grade quality, on-style). Aggregate → a single pass/fail + targeted feedback. Adversarial verification beats one score.

**Outer loop (cross-session) — engagement + memory**
```
publish → wait → read_metrics
  → compare vs prediction; distill a verified rule into memory
    (e.g. "first-2s hook drives retention for Viral Short")
  → next job consults memory → better starting brief & rubric weights
```

## 8. Video Styles & Director Rubrics

Each style is a verifier persona + a checkable rubric (seed set, extensible):

- **Viral Short** — producer persona. Rubric: hook in first 2s, pace/cut density, caption legibility, loop-ability, trend-fit.
- **Cinematic Story** — film-director persona. Rubric: narrative arc, shot continuity, color grade cohesion, music/beat sync, emotional payoff.
- **Explainer / Product** — editor persona. Rubric: clarity of message, info pacing, on-screen text correctness, structure (problem→solution→CTA).

Rubrics are files the verifier grades against — so "done" is machine-checkable, satisfying the orchestration criterion.

## 9. Tech-Stack Mapping

| Concern | Choice |
|---|---|
| Frontend / app | Next.js (Vercel) |
| UI components / styling | shadcn/ui + Tailwind CSS |
| Agentic UI / streaming | Vercel AI SDK |
| Agent brain (long-horizon) | Claude Opus 4.8 (`claude-opus-4-8`) via Claude Code on Daytona |
| Agent host / sandbox / memory / exec | Daytona (persistent workspace) |
| App→agent bridge | Claude Agent SDK (headless launch/monitor) |
| Batch orchestration | Claude Code dynamic workflows (saved scripts) |
| Hosted models (transcribe, VLM, embeddings) | Replicate |
| DB / vectors / storage / realtime / auth | Supabase |
| Editing / grading | ffmpeg + `.cube` LUTs |
| Motion graphics | Remotion |
| Outer loop | Social platform API (publish + metrics) |
| Optional render burst | Modal |

## 10. Demo Flow & Scope

**Demo (must work live):**
1. Upload 5–10 raw clips → preprocessing runs (parallel workflow), progress streams to UI.
2. Pick **Viral Short**, vertical 9:16, 30s.
3. Generate → watch the inner loop: EDL → cut → grade → render → director grade → self-correct → pass.
4. Preview the finished video + see the rubric scorecard.
5. Publish to the connected platform → engagement comes back → agent records a memory rule and proposes the next iteration informed by it.

**In-scope:** ingest, preprocess/understand, brief UI, full inner generation loop with verifier self-correction, Remotion overlays, color grade, one-platform publish + metrics → memory outer loop.

**Bounded for risk:** one social platform; three seed styles; demo-length videos (≤60s).

## 11. Autonomy & Orchestration (how we score well)

- **Brief + rubric files** are the inputs; another team could rerun on new footage tomorrow.
- **"Done" is verifiable without a human:** the director verifier must pass the rubric before the agent stops (`/goal`).
- **Session log** shows the agent catching its own errors (grade fails → self-fix), not humans pointing them out.
- **Saved workflow scripts** (preprocess fan-out, grading panel) are the repeatable orchestration artifact.

## 12. Risks & Mitigations

- **Render latency in a live demo** → keep the Daytona workspace warm; cap demo length; cache preprocessing; burst to Modal only if needed.
- **Verifier reliability / reward-hacking** → multi-lens panel + adversarial grading; pairwise comparison where possible.
- **Social API auth/rate limits live** → DEFERRED for the demo (§0); removes this live risk entirely.
- **ffmpeg/Remotion edge cases** → one tested Remotion template + verified test render; **ffmpeg-burned-caption fallback** so a failed render still ships a captioned video (§0).
- **Cost/token blow-up from loops** → per-phase token budgets; cap self-correction iterations (3–4).
- **Loop fails to converge / stalls the demo** → retain best-scoring render; on cap exhaustion ship best-so-far with the partial scorecard. Never stall, never ship nothing (§0 Loop Termination).
- **Opus 4.8 needs more steering than Fable 5 on long runs** → tight `/goal`, machine-checkable rubric, hard caps, and a scripted-but-honest weak first cut so self-correction is short and visible.
- **App↔Daytona orchestration** → confirm headless launch + progress streaming (Agent SDK/CLI + Supabase Realtime) early.

## 13. Future

**Deferred from the hackathon demo (rank order to re-add post-demo):**
- Live social publish + real engagement → the true outer optimization loop.
- Live preprocessing pipeline on the demo path + pgvector vector/transcript search at library scale.
- Styles 2 & 3 (Cinematic Story, Explainer) with their director rubrics.
- Grading panel (multi-lens parallel verifiers) as a workflow.
- Full Supabase Realtime job-progress streaming; Modal render burst for throughput.

**Longer-horizon:**
- Multi-platform publishing and a true closed growth loop across many videos.
- A/B variant generation graded by predicted engagement.
- Figma MCP design handoff (per the deck) for branded overlays.
- User-defined custom styles/rubrics; voice/music generation; 4K mastering.
- Modal render farm for high-throughput parallel rendering.

## 14. Verification (how we'll know it works e2e)

- **Happy path:** upload → generate → a render appears with a passing rubric scorecard, with no human intervention between brief and ship.
- **Self-correction proof:** inject a weak first cut; confirm the verifier fails it and the agent produces an improved second cut that passes (visible in the session log).
- **Outer loop proof:** publish, pull metrics, and confirm a new memory rule is written and consulted on the next generation.
- **Repeatability:** a second team member reruns the same brief + rubric on new footage and gets a ship-ready video without editing code.
