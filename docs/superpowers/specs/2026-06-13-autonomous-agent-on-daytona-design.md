# Autonomous agent on Daytona — design

**Date:** 2026-06-13
**Status:** Design (awaiting approval → implementation plan)
**Visual companion:** `docs/loop-vs-agent-spec.html` (before/after side-by-side)

## 1. Goal

Make AutoCut's live "brain" an **autonomous Claude session** running on Daytona via the Claude Agent SDK, instead of the current deterministic in-process loop. The agent drives itself — searching clips, composing the cut, rendering, grading, and deciding when it's good enough — while the harness enforces hard termination caps and ships best-so-far.

The current in-process loop (`src/loop/controller.ts`, "build task #1") was always an interim, fully-tested building block. This change promotes the PRD's intended architecture ("Claude Code / Opus 4.8 on Daytona as the agent's home") to the live path.

## 2. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Autonomy model | **C — autonomy with a deterministic backstop** | Honors the PRD's "never trust the model to self-terminate; always ship something" rule *and* gives real autonomy. |
| Invocation | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, in-process) | agent-server is already TS; needs tight streaming, mid-run abort, custom tools wrapping existing modules. CLI route buys nothing. |
| First milestone | **Stub-tools first** | Real Claude brain + fake `render`/`search`/`grade` tool impls. Proves launch→stream→cap→deliver on Daytona cheaply; one suspect on failure, not four. |
| Old loop controller | **Keep as retired-but-tested library** (not deleted) | task-#1 artifact; tests keep the contracts honest; usable as a fallback engine. Leaves the live path only. |
| New code location | **`src/agent/`** (parallel to `src/loop/`) | Clear seam between retired engine and new brain. |

## 3. Architecture: what moves

The boundary between "model" and "deterministic code" does not disappear — it **moves**. Before, JS held the loop and the model filled in two blanks (build, grade). After, the model holds the loop and JS draws a **fence** around it (caps) and a **camera** on it (stream-watch → events + best-so-far).

```
BEFORE (today)                          AFTER (this change)
controller.ts while-gate drives    →    Claude (Agent SDK query()) drives
  ① buildEdl  (one-shot agent)            tool: search_clips, build_edl
  ②③④ validate/render/overlay (JS)        tool: render
  ⑤ grade     (one-shot agent)            tool: grade (independent verifier inside)
  ⑥ best-so-far (JS)                      tool: publish  ("I'm satisfied")
  while: iters<4 && tokens && wall        fence: maxTurns + maxBudgetUsd + wall-clock close()
                                          camera: stream-watch → emit events + best-so-far
```

`agent-server.ts`'s Supabase plumbing is **untouched** on both sides (claim, Realtime subscribe, events emit, memory consult/distill, Storage upload, status).

## 4. Components

### 4.1 New — `src/agent/tools.ts`
Defines the toolset as in-process Agent SDK tools via `tool()` + `createSdkMcpServer()`:
- `search_clips` — find candidate clips for the brief
- `build_edl` — compose an Edit Decision List
- `render` — produce a render (returns a `render_ref`)
- `grade` — score a render against the rubric; **internally calls an independent verifier** (fresh context, sees only render + rubric — preserves the PRD's verifier independence). Returns the grade to Claude so it can decide to fix or publish.
- `publish` — Claude's explicit "good enough, ship it" signal (the clean exit)

Each tool takes an **injected implementation** (same DI pattern the loop already uses), so we ship **stub impls now** and swap to real (`src/edit/cut.ts`, `src/render/render.ts`, `src/verify/grade.ts`, real clip search) later **without touching the agent**. Tool handlers return the SDK shape `{ content: [{ type: 'text', text }] }`.

### 4.2 New — `src/agent/session.ts`
`runAgentSession(input, toolImpls, emit)`:
1. Build `systemPrompt` = goal + rubric + consulted memory rules.
2. `createSdkMcpServer({ name: 'autocut', tools })`.
3. `query({ prompt: goal, options: { model: 'claude-opus-4-8', mcpServers, allowedTools, permissionMode: 'bypassPermissions', maxTurns, maxBudgetUsd } })`.
4. `setTimeout(() => query.close(), CAP_WALL_MS)` for the wall-clock cap.
5. `for await (const msg of query)`:
   - `assistant` messages → map tool steps to `LoopEvent` → `emit` (◆ events rows).
   - `grade` tool results → update best-so-far (unconditional `max`).
   - `result` message (`success | error_max_turns | error_max_budget_usd`) → clear timer, return.
6. **Returns the exact shape `runLoop` returned** (`{ shipped: { render, grade } | null, passed }`), so `executeRun`'s distill → upload → status tail is unchanged.

### 4.3 The deterministic backstop (caps)
Three layers, all enforced outside Claude's judgment:
- `maxTurns` — SDK-enforced (`result.subtype = "error_max_turns"`).
- `maxBudgetUsd` — SDK-enforced (`result.subtype = "error_max_budget_usd"`).
- Wall-clock — harness `setTimeout` → `query.close()`.

On any cap trip, the harness ships the **best-so-far** render it recorded from streamed `grade` results. (Token usage is only on the final `result`, not per-turn — so the budget cap is `maxBudgetUsd`, and best-so-far is tracked from observable tool calls, not token counters.)

### 4.4 Changed — `src/server/agent-server.ts`
- `executeRun`: replace `runLoop(input, deps, {...})` with `runAgentSession(input, toolImpls, emit)` (one call site).
- Env: `RENDER_MODE=stub|real` → `AGENT_TOOLS=stub|real` (selects which tool impls inject).
- Imports change from `../loop/controller.js` / `../loop/deps.js` / `../loop/stubs.js` to `../agent/session.js` / `../agent/tools.js`.
- **New required env:** `ANTHROPIC_API_KEY` (the brain is real Claude even in stub-tools mode).
- Everything else (claim, reclaim, subscribe, emit, consult, distill, upload, status) unchanged.

### 4.5 Retired from live path (kept in repo, tests stay green)
`src/loop/controller.ts`, `src/loop/deps.ts`, `src/loop/stubs.ts` (loop wiring), `src/loop/demo.ts`. Their unit/integration tests remain and keep the module contracts honest. Reusable as a fallback engine. `src/edit/cut.ts`, `src/render/render.ts`, `src/verify/grade.ts` are **reused** as real tool impls later.

## 5. Daytona sandbox prep & first integration test (stub-tools)

Prerequisite — Supabase ready (once, from laptop): `supabase link && supabase db push` (applies `0001_runs_events.sql` → tables, Realtime publication, `renders` bucket). Grab `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

Sandbox steps:
1. Create a Daytona sandbox from the repo; Node ≥ 20.
2. `npm install`. (Verify the Agent SDK runtime deps resolve in the sandbox — flagged risk below.)
3. Env (export them — the worker reads `process.env`, it does **not** auto-load `.env`):
   - `ANTHROPIC_API_KEY=...` (headless auth for the Agent SDK)
   - `SUPABASE_URL=...`, `SUPABASE_SERVICE_ROLE_KEY=...`
   - `MEMORY_DIR=/workspace/memory` (persistent volume → memory survives restarts)
   - `AGENT_TOOLS=stub`
4. `npm run agent` → expect `[agent] online` + `runs subscription: SUBSCRIBED`.
5. Insert a `queued` run (UI "Generate" or SQL). Watch: `events` stream live, the agent autonomously calls tools, a cap or `publish` ends it, `runs` flips to `shipped`, UI feed updates.
6. Restart-safety check: insert while worker is down → `reclaimQueued` sweeps it on boot.

Then Phase 3 (later): `AGENT_TOOLS=real` + ffmpeg + Remotion headless Chromium, swapping tool impls one at a time.

## 6. References to reconcile (from read-only audit)

These are **prose/config** references that would be inaccurate once the live path swaps. Code-comment fixes ride along with the code change in the same module. **Edits happen in the implementation plan, not in design.**

**MUST-UPDATE:**
- `package.json` L6 — description "self-correction loop controller (task #1)" → reframe to the agent-session brain.
- `docs/architecture-flow.html` — L146, L212, L216, L217, L245–255, L287, L310, L315: all attribute the live loop/termination/emit to the deterministic `loop/` controller. Update to "Agent SDK session drives; harness fences (caps) + watches (stream → events)."
- `src/server/agent-server.ts` header comment — L5, L16, L19, L36–38 (ASCII diagram + import list mirror the code that changes; update alongside the call-site swap).

**Follow-on (code, not prose):** `src/server/server.test.ts` L21/247/297/323 — tests of `executeRun` via `makeStubDeps` must track the call-site swap (handled in the migration PR).

**Whole-file decisions:**
- `docs/loop-controller-spec.html` — entirely about the retired engine; correctly framed as "build step 1." **Add a top banner**: "Retired from the live path as of the Agent SDK migration — see `loop-vs-agent-spec.html`. Describes the deterministic engine, now kept as a tested library and fallback." Converts every borderline line into unambiguous history.
- `docs/loop-vs-agent-spec.html` — the canonical post-migration reference. Keep as-is.

**Confirmed STILL-ACCURATE (no change):** everything under `src/loop/**` (self-describes as task-#1 library), the PRD's "self-correction loop = the product" language (product concept, not a driver claim), and the PRD's "Claude on Daytona = the brain" passages (already closer to the new architecture).

## 7. Testing strategy

- **Unit (offline, no network):** `session.ts` best-so-far tracking and cap-exit mapping, tested by feeding a mock async-iterator of SDK messages (mirrors how `controller.test.ts` mocks deps). Stub tool impls tested directly.
- **`executeRun` unit test:** keep it importable/network-free; mock the Supabase client + a mock `runAgentSession`. Update `server.test.ts` to the new injection.
- **Retained-library tests:** `src/loop/**` tests stay green unchanged — proof the fallback engine still works.
- **Integration (gated, needs keys):** the Daytona stub-tools run in §5 is the end-to-end acceptance test.

## 8. Risks & open items

- **Agent SDK headless auth/runtime in the sandbox** — confirm `@anthropic-ai/claude-agent-sdk` runs headless with `ANTHROPIC_API_KEY` and that its runtime resolves cleanly on the Daytona image. Verify early (PRD's "confirm headless launch + progress streaming early" risk).
- **`maxBudgetUsd` calibration** — pick a small ceiling for stub-tools so a runaway agent can't burn budget; tune for real-tools.
- **Best-so-far requires an observable grade** — the agent must call `grade` before `publish`; the systemPrompt must instruct it to grade each render. If it publishes ungraded, harness ships the last render with no score.
- **Event mapping fidelity** — `events` rows must stay shaped as the UI expects (`{ run_id, iteration, phase, message, score_snapshot?, render_ref?, ts }`); map SDK tool steps onto that contract.

## 9. Out of scope

Real ffmpeg/Remotion/Replicate tool impls (Phase 3), Modal burst rendering, social publish/metrics outer loop, multi-worker scaling beyond the existing atomic-claim safety, and deleting the retired loop library.
