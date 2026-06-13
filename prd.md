# AutoCut — Autonomous AI Video Editor (PRD v0.1)

*Working title — rename freely.*

## 1. Context & Goal

**Problem.** End-to-end video editing — scripting, clip selection, cutting, color grading, motion graphics, and optimizing for engagement — is slow, skilled, and tool-heavy. Creators spend hours in timelines for every minute of output.

**Goal.** Put Claude **Opus 4.8** at the center of an autonomous pipeline that takes **raw video assets + a high-level brief** and produces a **finished, graded, motion-enhanced video** — selecting clips, editing with ffmpeg, color grading, overlaying Remotion motion graphics, and **grading its own output against a style rubric**, self-correcting in a loop until the rubric passes. It then publishes, reads real engagement data, and uses that as an **outer optimization signal**.

**Done looks like.** A user uploads a handful of raw clips, picks a style + aspect ratio + length, clicks generate, and — with minimal human intervention — receives a polished video that a director-grade verifier agent has scored as "ship-ready." The session log shows the agent caught and fixed its own mistakes.

**Non-goals (v1).** Frame-perfect 4K broadcast mastering; a manual timeline editor; multi-user collaboration; arbitrary platform support.

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
- **Social API auth/rate limits live** → pre-authorize the account; have a recorded fallback for the publish step.
- **ffmpeg/Remotion edge cases** → constrain transitions/overlays to a tested set for the demo.
- **Cost/token blow-up from loops** → per-phase token budgets; cap self-correction iterations.
- **App↔Daytona orchestration** → confirm headless launch + progress streaming (Agent SDK/CLI + Supabase Realtime) early.

## 13. Future

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
