# Autonomous Agent on Daytona — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AutoCut's live deterministic loop brain with an autonomous Claude Agent SDK session (Option C: the agent drives itself; the harness fences it with hard caps and ships best-so-far), wired through the existing `agent-server.ts` plumbing, running stub tools first.

**Architecture:** A new `src/agent/` module. `tools.ts` exposes the agent's capabilities (`search_clips`, `build_edl`, `render`, `grade`, `publish`) as pure tool *specs* (name + zod shape + handler) wrapping injected implementations (`ToolImpls`) — stub now, real later. `tracker.ts` keeps best-so-far and maps the SDK's terminal subtype to a `LoopResult`. `session.ts` (`runAgentSession`) is the glue: it builds the tools, launches `query()`, fences it with `maxTurns`/`maxBudgetUsd`/wall-clock-`close()`, streams steps to Supabase `events`, and returns the **exact `LoopResult` shape `runLoop` returned**. `sdk.ts` is the only file that imports the SDK (dynamic import), providing the real `query` + server builder. `executeRun` in `agent-server.ts` swaps one call site; all its Supabase plumbing is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@anthropic-ai/claude-agent-sdk`, `zod`, `vitest`, existing `src/loop/types.ts` contracts.

**Spec:** `docs/superpowers/specs/2026-06-13-autonomous-agent-on-daytona-design.md`
**Visual:** `docs/loop-vs-agent-spec.html`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/agent/tools.ts` *(new)* | `ToolImpls` interface, `makeStubToolImpls`, `ToolSpec` type, `createAutocutTools` (pure: specs + allowedTools, wired to a `Tracker` + `emit`). No SDK import. |
| `src/agent/tracker.ts` *(new)* | `Tracker` class: record graded renders, track best-so-far + published id, `summarize(subtype) → LoopResult`. No SDK import. |
| `src/agent/prompt.ts` *(new)* | `buildSystemPrompt(brief, rubric)` — the agent's goal + workflow + cap awareness. |
| `src/agent/session.ts` *(new)* | `runAgentSession(input, deps)` glue. Injectable `query`, `buildServer`, `toolImpls`, `caps`, `setTimer`. No static SDK import. |
| `src/agent/sdk.ts` *(new)* | The sealed SDK seam (dynamic `import("@anthropic-ai/claude-agent-sdk")`): `realQuery`, `realBuildServer`. Untested entry, mirrors `agent-server.ts` `main`. |
| `src/server/agent-server.ts` *(modify)* | Swap `runLoop` → `runAgentSession` in `executeRun`; `RENDER_MODE` → `AGENT_TOOLS`; new imports; header comment. |
| `src/server/server.test.ts` *(modify)* | Update `executeRun` test to inject a `runSession` stub instead of `makeStubDeps`. |
| `package.json` *(modify)* | Add dependency; reframe description. |
| `docs/architecture-flow.html`, `docs/loop-controller-spec.html` *(modify)* | Reconcile prose with the new live path (from audit). |

`src/loop/**` is **kept and untouched** (retired-but-tested library + fallback). `src/edit/cut.ts`, `src/render/render.ts`, `src/verify/grade.ts` are reused later as real `ToolImpls` (out of scope here).

---

## Task 1: Add the Claude Agent SDK dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

Run:
```bash
npm install @anthropic-ai/claude-agent-sdk
```
Expected: package added to `dependencies`, no peer-dep errors.

- [ ] **Step 2: Verify the three exports we depend on exist**

Run:
```bash
node -e "const s=require('@anthropic-ai/claude-agent-sdk'); console.log(['query','tool','createSdkMcpServer'].map(k=>k+':'+typeof s[k]).join(' '))"
```
Expected: `query:function tool:function createSdkMcpServer:function`.
If any is `undefined`, STOP and check the installed version's exports (`node -e "console.log(Object.keys(require('@anthropic-ai/claude-agent-sdk')))"`) before continuing — later tasks assume these names.

- [ ] **Step 3: Typecheck + tests still green (nothing wired yet)**

Run: `npm run typecheck && npm test`
Expected: PASS (no source changed yet besides package.json).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @anthropic-ai/claude-agent-sdk dependency"
```

---

## Task 2: Stub tool implementations (`ToolImpls` + `makeStubToolImpls`)

**Files:**
- Create: `src/agent/tools.ts`
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/tools.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { EdlSchema, RUBRIC_DIMENSIONS } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls } from "./tools.js";

describe("makeStubToolImpls", () => {
  it("searchClips returns the library clips", async () => {
    const impls = makeStubToolImpls();
    const clips = await impls.searchClips("anything", SAMPLE_LIBRARY);
    expect(clips.map((c) => c.id)).toEqual(["c01", "c02"]);
  });

  it("buildEdl returns a schema-valid EDL", async () => {
    const impls = makeStubToolImpls();
    const raw = await impls.buildEdl(["c01"], "open on the hook", SAMPLE_LIBRARY);
    expect(EdlSchema.safeParse(raw).success).toBe(true);
  });

  it("render returns a unique ref each call", async () => {
    const impls = makeStubToolImpls();
    const edl = EdlSchema.parse(await impls.buildEdl(["c01"], "", SAMPLE_LIBRARY));
    const r1 = await impls.render(edl);
    const r2 = await impls.render(edl);
    expect(r1.output).not.toEqual(r2.output);
  });

  it("grade follows a weak-then-pass script", async () => {
    const impls = makeStubToolImpls();
    const edl = EdlSchema.parse(await impls.buildEdl(["c01"], "", SAMPLE_LIBRARY));
    const r = await impls.render(edl);
    const g1 = await impls.grade(r, VIRAL_RUBRIC);
    const g2 = await impls.grade(r, VIRAL_RUBRIC);
    const passes = (g: typeof g1) => RUBRIC_DIMENSIONS.every((d) => g.scores[d] >= VIRAL_RUBRIC.passThreshold);
    expect(passes(g1)).toBe(false);
    expect(passes(g2)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/tools.test.ts`
Expected: FAIL — `Cannot find module './tools.js'` / `makeStubToolImpls is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/agent/tools.ts`:
```ts
/**
 * The agent's toolset (plan Component 2, Agent SDK migration).
 *
 * Pure: defines the four side-effecting operations as injectable `ToolImpls`
 * (stub now, real ffmpeg/Claude later) plus `createAutocutTools`, which wraps
 * them into SDK-agnostic tool *specs*. The SDK is never imported here — sdk.ts
 * turns these specs into a real MCP server, and tests call the handlers directly.
 */
import { z } from "zod";
import {
  EdlSchema,
  RUBRIC_DIMENSIONS,
  type Clip,
  type ClipLibrary,
  type Edl,
  type Grade,
  type LoopEvent,
  type RenderResult,
} from "../loop/types.js";
import type { Rubric } from "../loop/controller.js";

/** The four operations the agent's tools wrap. Injected: stub now, real later. */
export interface ToolImpls {
  searchClips(query: string, library: ClipLibrary): Promise<Clip[]>;
  /** May return malformed output — the build_edl tool validates with EdlSchema. */
  buildEdl(clipIds: string[], rationale: string, library: ClipLibrary): Promise<unknown>;
  render(edl: Edl): Promise<RenderResult>;
  grade(render: RenderResult, rubric: Rubric): Promise<Grade>;
}

/** Default money-shot script: a weak first cut, then a pass (mirrors loop/stubs). */
const DEFAULT_GRADE_SCRIPT: Grade["scores"][] = [
  { hook_strength: 5, pace_cut_density: 8, caption_legibility: 6, loopability: 7, on_style_trend_fit: 8 },
  { hook_strength: 8, pace_cut_density: 9, caption_legibility: 8, loopability: 8, on_style_trend_fit: 9 },
];

export function makeStubToolImpls(opts: { gradeScript?: Grade["scores"][] } = {}): ToolImpls {
  const script = opts.gradeScript ?? DEFAULT_GRADE_SCRIPT;
  let edlSeq = 0;
  let renderSeq = 0;
  let gradeCalls = 0;

  return {
    async searchClips(_query, library) {
      return library.clips;
    },
    async buildEdl(clipIds, rationale, library) {
      const clip = library.clips.find((c) => clipIds.includes(c.id)) ?? library.clips[0]!;
      edlSeq += 1;
      return {
        edlId: `edl-${edlSeq}`,
        aspect: "9:16",
        targetLenS: 30,
        lut: null,
        segments: [
          {
            clipId: clip.id,
            in: 0,
            out: Math.min(clip.duration, 6),
            transition: "cut",
            captions: [{ text: "wait for the drop", t0: 0, t1: 1.5, style: "bold-center" }],
          },
        ],
        selectionRationale: rationale || `open on ${clip.id}`,
      };
    },
    async render(edl) {
      renderSeq += 1;
      return {
        renderId: `render-${renderSeq}`,
        output: `storage://renders/${edl.edlId}-${renderSeq}.mp4`,
        usedFallback: false,
      };
    },
    async grade(render, rubric) {
      const idx = Math.min(gradeCalls, script.length - 1);
      gradeCalls += 1;
      const scores = script[idx]!;
      const feedback: Record<string, string> = {};
      for (const d of RUBRIC_DIMENSIONS) {
        if (scores[d] < rubric.passThreshold) feedback[d] = `${d} is below ${rubric.passThreshold}`;
      }
      return { renderId: render.renderId, scores, feedback };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat(agent): stub tool implementations"
```

---

## Task 3: Best-so-far tracker + result summary (`Tracker`)

**Files:**
- Create: `src/agent/tracker.ts`
- Test: `src/agent/tracker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/tracker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { Grade, RenderResult } from "../loop/types.js";
import { VIRAL_RUBRIC } from "../loop/stubs.js";
import { Tracker } from "./tracker.js";

const render = (id: string): RenderResult => ({ renderId: id, output: `s://${id}.mp4`, usedFallback: false });
const grade = (id: string, n: number): Grade => ({
  renderId: id,
  scores: { hook_strength: n, pace_cut_density: n, caption_legibility: n, loopability: n, on_style_trend_fit: n },
  feedback: {},
});

describe("Tracker", () => {
  it("keeps the best aggregate (5,8,6 -> 8)", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 5), 1);
    t.record(render("r2"), grade("r2", 8), 2);
    t.record(render("r3"), grade("r3", 6), 3);
    const res = t.summarize("success");
    expect(res.shipped?.render.renderId).toBe("r2");
  });

  it("passed is true only when every dimension meets threshold", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 6), 1);
    expect(t.summarize("success").passed).toBe(false);
    t.record(render("r2"), grade("r2", 7), 2);
    expect(t.summarize("success").passed).toBe(true);
  });

  it("maps SDK terminal subtypes to stopReason", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    t.record(render("r1"), grade("r1", 7), 1);
    expect(t.summarize("error_max_turns").stopReason).toBe("max-iters");
    expect(t.summarize("error_max_budget_usd").stopReason).toBe("token-budget");
    expect(t.summarize("wallclock").stopReason).toBe("wallclock");
    expect(t.summarize("success").stopReason).toBe("passed");
  });

  it("ships nothing (no-valid-render) when no render was graded", () => {
    const t = new Tracker(VIRAL_RUBRIC);
    const res = t.summarize("success");
    expect(res.shipped).toBeNull();
    expect(res.stopReason).toBe("no-valid-render");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/tracker.test.ts`
Expected: FAIL — `Cannot find module './tracker.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/agent/tracker.ts`:
```ts
/**
 * Best-so-far tracker for the autonomous agent session.
 *
 * The agent decides what to do; this records every graded render so the harness
 * can ALWAYS ship something, and maps the SDK's terminal `result.subtype` onto
 * the existing `LoopResult.stopReason`. Mirrors the loop controller's candidate
 * ranking (more passing dimensions wins; ties break on total score).
 */
import { RUBRIC_DIMENSIONS, type Grade, type RenderResult } from "../loop/types.js";
import type { LoopResult, Rubric, StopReason } from "../loop/controller.js";

interface Best {
  render: RenderResult;
  grade: Grade;
  iteration: number;
  passedCount: number;
  aggregate: number;
}

export class Tracker {
  private best: Best | null = null;
  private published: string | null = null;
  private maxIteration = 0;

  constructor(private readonly rubric: Rubric) {}

  record(render: RenderResult, grade: Grade, iteration: number): void {
    this.maxIteration = Math.max(this.maxIteration, iteration);
    const passedCount = RUBRIC_DIMENSIONS.filter((d) => grade.scores[d] >= this.rubric.passThreshold).length;
    const aggregate = RUBRIC_DIMENSIONS.reduce((sum, d) => sum + grade.scores[d], 0);
    const better =
      this.best === null ||
      passedCount > this.best.passedCount ||
      (passedCount === this.best.passedCount && aggregate > this.best.aggregate);
    if (better) this.best = { render, grade, iteration, passedCount, aggregate };
  }

  publish(renderId: string): void {
    this.published = renderId;
  }

  get iterations(): number {
    return this.maxIteration;
  }

  summarize(subtype: string): LoopResult {
    const passed = this.best !== null && this.best.passedCount === RUBRIC_DIMENSIONS.length;
    const stopReason: StopReason =
      subtype === "error_max_turns"
        ? "max-iters"
        : subtype === "error_max_budget_usd"
          ? "token-budget"
          : subtype === "wallclock"
            ? "wallclock"
            : this.best !== null
              ? "passed"
              : "no-valid-render";
    return {
      passed,
      iterations: this.maxIteration,
      stopReason,
      shipped: this.best
        ? { render: this.best.render, grade: this.best.grade, iteration: this.best.iteration }
        : null,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/tracker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tracker.ts src/agent/tracker.test.ts
git commit -m "feat(agent): best-so-far tracker + LoopResult summary"
```

---

## Task 4: The tool specs (`createAutocutTools`)

**Files:**
- Modify: `src/agent/tools.ts`
- Modify: `src/agent/tools.test.ts`

- [ ] **Step 1: Write the failing test (append to `src/agent/tools.test.ts`)**

Add these imports at the top of the file (extend the existing import lines):
```ts
import type { LoopEvent } from "../loop/types.js";
import { Tracker } from "./tracker.js";
import { createAutocutTools } from "./tools.js";
```

Append this describe block:
```ts
describe("createAutocutTools", () => {
  function setup() {
    const events: LoopEvent[] = [];
    const tracker = new Tracker(VIRAL_RUBRIC);
    const { specs, allowedTools } = createAutocutTools({
      impls: makeStubToolImpls(),
      library: SAMPLE_LIBRARY,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: (e) => events.push({ ...e, ts: 0 }),
    });
    const byName = (n: string) => specs.find((s) => s.name === n)!;
    return { events, tracker, specs, allowedTools, byName };
  }

  it("exposes the five tools with mcp__autocut__ allowedTools", () => {
    const { specs, allowedTools } = setup();
    expect(specs.map((s) => s.name).sort()).toEqual(
      ["build_edl", "grade", "publish", "render", "search_clips"],
    );
    expect(allowedTools).toContain("mcp__autocut__publish");
  });

  it("build_edl validates and caches; render+grade record best-so-far and emit", async () => {
    const { events, tracker, byName } = setup();
    await byName("search_clips").handler({ query: "hook" });
    const build = await byName("build_edl").handler({ clipIds: ["c01"], rationale: "x" });
    const edlId = /edlId=(\S+)/.exec(build.content[0]!.text)![1]!;
    const render = await byName("render").handler({ edlId });
    const renderId = /renderId=(\S+)/.exec(render.content[0]!.text)![1]!;
    const grade = await byName("grade").handler({ renderId });
    expect(grade.content[0]!.text).toMatch(/NOT YET/);
    expect(tracker.summarize("success").shipped?.render.renderId).toBe(renderId);
    expect(events.map((e) => e.phase)).toEqual(["select", "build", "render", "grade"]);
  });

  it("build_edl returns INVALID_EDL text (not a throw) on bad output", async () => {
    const events: LoopEvent[] = [];
    const tracker = new Tracker(VIRAL_RUBRIC);
    const badImpls = { ...makeStubToolImpls(), buildEdl: async () => ({ edlId: "bad", segments: [] }) };
    const { specs } = createAutocutTools({
      impls: badImpls,
      library: SAMPLE_LIBRARY,
      rubric: VIRAL_RUBRIC,
      tracker,
      emit: (e) => events.push({ ...e, ts: 0 }),
    });
    const out = await specs.find((s) => s.name === "build_edl")!.handler({ clipIds: ["c01"] });
    expect(out.content[0]!.text).toMatch(/INVALID_EDL/);
  });

  it("publish marks the tracker", async () => {
    const { tracker, byName } = setup();
    const build = await byName("build_edl").handler({ clipIds: ["c01"] });
    const edlId = /edlId=(\S+)/.exec(build.content[0]!.text)![1]!;
    const render = await byName("render").handler({ edlId });
    const renderId = /renderId=(\S+)/.exec(render.content[0]!.text)![1]!;
    const out = await byName("publish").handler({ renderId });
    expect(out.content[0]!.text).toMatch(/PUBLISHED/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/tools.test.ts`
Expected: FAIL — `createAutocutTools is not a function`.

- [ ] **Step 3: Add the implementation to `src/agent/tools.ts`**

Append to `src/agent/tools.ts`:
```ts
/** An SDK-agnostic tool spec. sdk.ts turns these into real SDK tools. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>;
}

export interface AutocutToolsDeps {
  impls: ToolImpls;
  library: ClipLibrary;
  rubric: Rubric;
  tracker: import("./tracker.js").Tracker;
  emit: (e: Omit<LoopEvent, "ts">) => void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * Build the five tool specs, wired to the injected impls, the tracker (best-so-far),
 * and the event sink. `iteration` increments on each build_edl — the agent's
 * self-correction rounds, surfaced to the UI exactly like the loop's iterations.
 */
export function createAutocutTools(deps: AutocutToolsDeps): { specs: ToolSpec[]; allowedTools: string[] } {
  const { impls, library, rubric, tracker, emit } = deps;
  const edls = new Map<string, Edl>();
  const renders = new Map<string, RenderResult>();
  let iteration = 0;

  const specs: ToolSpec[] = [
    {
      name: "search_clips",
      description: "Search the clip library. Returns id, caption, and tags for each candidate clip.",
      schema: { query: z.string() },
      handler: async (args) => {
        const clips = await impls.searchClips(String(args.query ?? ""), library);
        emit({ iteration, phase: "select", message: `search_clips → ${clips.length} candidates` });
        return text(clips.map((c) => `${c.id}: ${c.caption} [${c.tags.join(", ")}]`).join("\n"));
      },
    },
    {
      name: "build_edl",
      description: "Compose an Edit Decision List from clip ids. Returns edlId, or INVALID_EDL to fix.",
      schema: { clipIds: z.array(z.string()), rationale: z.string().optional() },
      handler: async (args) => {
        iteration += 1;
        const clipIds = (args.clipIds as string[]) ?? [];
        emit({ iteration, phase: "build", message: `build_edl from [${clipIds.join(", ")}]` });
        const raw = await impls.buildEdl(clipIds, String(args.rationale ?? ""), library);
        const parsed = EdlSchema.safeParse(raw);
        if (!parsed.success) {
          const why = parsed.error.issues[0]?.message ?? "schema error";
          emit({ iteration, phase: "fix", message: `EDL invalid: ${why}` });
          return text(`INVALID_EDL: ${why}. Adjust clip selection/structure and call build_edl again.`);
        }
        edls.set(parsed.data.edlId, parsed.data);
        return text(`edlId=${parsed.data.edlId} (validated, ${parsed.data.segments.length} segment(s))`);
      },
    },
    {
      name: "render",
      description: "Render a built EDL to a video. Returns renderId and output ref.",
      schema: { edlId: z.string() },
      handler: async (args) => {
        const edl = edls.get(String(args.edlId));
        if (!edl) return text(`UNKNOWN_EDL: ${args.edlId}. Call build_edl first.`);
        const r = await impls.render(edl);
        renders.set(r.renderId, r);
        emit({
          iteration,
          phase: "render",
          message: `render ${r.renderId}${r.usedFallback ? " (fallback overlay)" : ""}`,
          renderRef: r.output,
        });
        return text(`renderId=${r.renderId} output=${r.output}`);
      },
    },
    {
      name: "grade",
      description: "Grade a render against the rubric. You MUST grade every render before publishing.",
      schema: { renderId: z.string() },
      handler: async (args) => {
        const r = renders.get(String(args.renderId));
        if (!r) return text(`UNKNOWN_RENDER: ${args.renderId}. Call render first.`);
        const g = await impls.grade(r, rubric);
        tracker.record(r, g, iteration);
        const passedCount = RUBRIC_DIMENSIONS.filter((d) => g.scores[d] >= rubric.passThreshold).length;
        emit({
          iteration,
          phase: "grade",
          message: `grade ${r.renderId}: ${passedCount}/${RUBRIC_DIMENSIONS.length} dims pass`,
          scores: g.scores,
          renderRef: r.output,
        });
        const fb = Object.entries(g.feedback).map(([d, n]) => `- ${d}: ${n}`).join("\n");
        const verdict =
          passedCount === RUBRIC_DIMENSIONS.length
            ? "PASS — every dimension meets the threshold. Call publish."
            : `NOT YET — ${passedCount}/${RUBRIC_DIMENSIONS.length} dimensions pass. Improve the EDL and re-render.`;
        return text(`${verdict}\nscores=${JSON.stringify(g.scores)}${fb ? `\n${fb}` : ""}`);
      },
    },
    {
      name: "publish",
      description: "Ship a render as the final cut. Call only after a grade you are satisfied with.",
      schema: { renderId: z.string() },
      handler: async (args) => {
        const r = renders.get(String(args.renderId));
        if (!r) return text(`UNKNOWN_RENDER: ${args.renderId}.`);
        tracker.publish(r.renderId);
        emit({ iteration, phase: "ship", message: `agent published ${r.renderId}`, renderRef: r.output });
        return text(`PUBLISHED ${r.renderId}. You are done.`);
      },
    },
  ];

  const allowedTools = specs.map((s) => `mcp__autocut__${s.name}`);
  return { specs, allowedTools };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/tools.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts
git commit -m "feat(agent): autocut tool specs wired to tracker + events"
```

---

## Task 5: System prompt builder

**Files:**
- Create: `src/agent/prompt.ts`
- Test: `src/agent/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/prompt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RUBRIC_DIMENSIONS } from "../loop/types.js";
import { VIRAL_RUBRIC } from "../loop/stubs.js";
import { buildSystemPrompt } from "./prompt.js";

describe("buildSystemPrompt", () => {
  it("includes the brief, every rubric dimension, threshold, and the grade-before-publish rule", () => {
    const p = buildSystemPrompt("Make a 20s beach short", VIRAL_RUBRIC);
    expect(p).toContain("Make a 20s beach short");
    expect(p).toContain(String(VIRAL_RUBRIC.passThreshold));
    for (const d of RUBRIC_DIMENSIONS) expect(p).toContain(d);
    expect(p.toLowerCase()).toContain("grade every render before");
    expect(p.toLowerCase()).toContain("publish");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/prompt.test.ts`
Expected: FAIL — `Cannot find module './prompt.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/agent/prompt.ts`:
```ts
/**
 * System prompt for the autonomous AutoCut agent.
 *
 * Encodes the goal, the rubric pass-bar, the tool workflow, and the cap reality:
 * the agent owns its loop, but turns/budget/wall-clock are fenced by the harness,
 * so when running low it must publish its best render rather than stop empty.
 */
import { RUBRIC_DIMENSIONS, type Rubric } from "../loop/types.js";

export function buildSystemPrompt(brief: string, rubric: Rubric): string {
  return [
    "You are AutoCut, an autonomous short-form video editor. You act ONLY through your tools.",
    "",
    `Goal: ${brief}`,
    "",
    `Rubric "${rubric.style}": a render PASSES only when EVERY dimension scores >= ${rubric.passThreshold}.`,
    "Dimensions:",
    RUBRIC_DIMENSIONS.map((d) => `  - ${d}`).join("\n"),
    "",
    "Workflow:",
    "  1. search_clips to see the library.",
    "  2. build_edl to compose a cut. If it returns INVALID_EDL, fix and call build_edl again.",
    "  3. render the EDL.",
    "  4. grade the render. You MUST grade every render before publishing.",
    "  5. If the grade is NOT YET, improve the EDL and re-render. If PASS, call publish.",
    "",
    "You are capped on turns, budget, and wall-clock time. If you are running low, publish your",
    "best graded render rather than stopping with nothing.",
  ].join("\n");
}
```

Note: `Rubric` is re-exported from `src/loop/types.ts`? It is defined in `src/loop/controller.ts`. Import it from there if `types.ts` does not export it. Verify with: `grep -n "export.*Rubric" src/loop/types.ts src/loop/controller.ts`. Use whichever path exports it (controller.ts per current code) — adjust the import line to `import type { Rubric } from "../loop/controller.js";` and keep `RUBRIC_DIMENSIONS` from `../loop/types.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/prompt.test.ts`
Expected: PASS. If it fails to compile on the `Rubric` import, apply the split-import note above and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt.ts src/agent/prompt.test.ts
git commit -m "feat(agent): system prompt builder"
```

---

## Task 6: Session glue (`runAgentSession`)

**Files:**
- Create: `src/agent/session.ts`
- Test: `src/agent/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/session.test.ts`. The fake `query` reads the tool specs out of `options.mcpServers.autocut.specs` (our fake `buildServer` passes them through) and drives a realistic search→build→render→grade→[publish] sequence, then yields a `result` — exercising the real handlers, tracker, and events with no SDK.
```ts
import { describe, it, expect } from "vitest";
import type { LoopEvent } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls, type ToolSpec } from "./tools.js";
import { runAgentSession, type QueryHandle, type SdkMessage } from "./session.js";

/** Fake buildServer: pass the specs straight through so the fake query can call them. */
const fakeBuildServer = (specs: ToolSpec[]) => ({ specs });

/** Fake query that drives the agent's tools to convergence, then ends with a result. */
function makeConvergingQuery(stopAfterPublish: boolean) {
  return (params: { prompt: string; options: Record<string, unknown> }): QueryHandle => {
    const server = (params.options.mcpServers as { autocut: { specs: ToolSpec[] } }).autocut;
    const call = (name: string, args: Record<string, unknown>) =>
      server.specs.find((s) => s.name === name)!.handler(args);
    let closed = false;
    async function* run(): AsyncGenerator<SdkMessage> {
      await call("search_clips", { query: "hook" });
      const b1 = await call("build_edl", { clipIds: ["c01"], rationale: "open on hook" });
      const edl1 = /edlId=(\S+)/.exec(b1.content[0]!.text)![1]!;
      const r1 = await call("render", { edlId: edl1 });
      const rid1 = /renderId=(\S+)/.exec(r1.content[0]!.text)![1]!;
      await call("grade", { renderId: rid1 }); // weak first grade
      yield { type: "assistant", message: { content: [{ type: "text", text: "first cut is weak, retrying" }] } };
      const b2 = await call("build_edl", { clipIds: ["c01"], rationale: "tighter" });
      const edl2 = /edlId=(\S+)/.exec(b2.content[0]!.text)![1]!;
      const r2 = await call("render", { edlId: edl2 });
      const rid2 = /renderId=(\S+)/.exec(r2.content[0]!.text)![1]!;
      await call("grade", { renderId: rid2 }); // passing grade
      if (stopAfterPublish && !closed) await call("publish", { renderId: rid2 });
      yield { type: "result", subtype: "success" };
    }
    const gen = run();
    return Object.assign(gen, { close: () => { closed = true; } });
  };
}

describe("runAgentSession", () => {
  it("drives the agent to a pass and returns a passing LoopResult", async () => {
    const events: LoopEvent[] = [];
    const res = await runAgentSession(
      { brief: "Make a beach short" },
      {
        query: makeConvergingQuery(true),
        buildServer: fakeBuildServer,
        toolImpls: makeStubToolImpls(),
        rubric: VIRAL_RUBRIC,
        library: SAMPLE_LIBRARY,
        emit: (e) => events.push(e),
        now: () => 0,
      },
    );
    expect(res.passed).toBe(true);
    expect(res.shipped).not.toBeNull();
    expect(res.stopReason).toBe("passed");
    expect(events.some((e) => e.phase === "grade")).toBe(true);
    expect(events.some((e) => e.phase === "ship")).toBe(true);
  });

  it("fires the wall-clock cap: close() is called and result maps to wallclock", async () => {
    let closeCalled = false;
    const fires: Array<() => void> = [];
    // a query that never yields a result until closed
    const hangingQuery = (params: { prompt: string; options: Record<string, unknown> }): QueryHandle => {
      async function* run(): AsyncGenerator<SdkMessage> {
        // yield nothing meaningful; wait for close() to flip the result
        while (!closeCalled) {
          yield { type: "assistant", message: { content: [] } };
          await Promise.resolve();
        }
        yield { type: "result", subtype: "success" };
      }
      const gen = run();
      return Object.assign(gen, { close: () => { closeCalled = true; } });
    };
    const res = await runAgentSession(
      { brief: "x" },
      {
        query: hangingQuery,
        buildServer: fakeBuildServer,
        toolImpls: makeStubToolImpls(),
        rubric: VIRAL_RUBRIC,
        library: SAMPLE_LIBRARY,
        now: () => 0,
        // synchronous timer: fire immediately so the test is deterministic
        setTimer: (_ms, fn) => { fires.push(fn); fn(); return { clear: () => {} }; },
      },
    );
    expect(closeCalled).toBe(true);
    expect(res.stopReason).toBe("wallclock");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/session.test.ts`
Expected: FAIL — `Cannot find module './session.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/agent/session.ts`:
```ts
/**
 * Autonomous agent session (Agent SDK migration, Option C).
 *
 * Claude owns the loop; this glue fences it. It builds the tools, launches the
 * injected `query()`, enforces the wall-clock cap via `close()`, forwards the
 * message stream to Supabase `events`, and returns the SAME `LoopResult` shape
 * the deterministic `runLoop` returned — so `executeRun` is untouched downstream.
 *
 * No static SDK import: `query` and `buildServer` are injected (real ones live in
 * sdk.ts behind a dynamic import), so this file and its tests run offline.
 */
import type { ClipLibrary, LoopEvent } from "../loop/types.js";
import type { LoopResult, Rubric } from "../loop/controller.js";
import { Tracker } from "./tracker.js";
import { createAutocutTools, type ToolImpls, type ToolSpec } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

export type SdkMessage = { type: string; subtype?: string; [k: string]: unknown };
export interface QueryHandle extends AsyncIterable<SdkMessage> {
  close(): void;
}
export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => QueryHandle;

export interface AgentCaps {
  maxTurns: number;
  maxBudgetUsd: number;
  wallclockMs: number;
}
export const DEFAULT_CAPS: AgentCaps = { maxTurns: 12, maxBudgetUsd: 0.5, wallclockMs: 120_000 };

export interface AgentSessionDeps {
  query: QueryFn;
  buildServer: (specs: ToolSpec[]) => unknown;
  toolImpls: ToolImpls;
  rubric: Rubric;
  library: ClipLibrary;
  emit?: (e: LoopEvent) => void;
  now?: () => number;
  caps?: AgentCaps;
  model?: string;
  setTimer?: (ms: number, fn: () => void) => { clear(): void };
}

function extractText(msg: SdkMessage): string {
  const content = (msg.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
}

export async function runAgentSession(
  input: { brief: string },
  deps: AgentSessionDeps,
): Promise<LoopResult> {
  const now = deps.now ?? Date.now;
  const caps = deps.caps ?? DEFAULT_CAPS;
  const setTimer =
    deps.setTimer ??
    ((ms, fn) => {
      const id = setTimeout(fn, ms);
      return { clear: () => clearTimeout(id) };
    });
  const emit = (e: Omit<LoopEvent, "ts">) => deps.emit?.({ ...e, ts: now() });

  const tracker = new Tracker(deps.rubric);
  const { specs, allowedTools } = createAutocutTools({
    impls: deps.toolImpls,
    library: deps.library,
    rubric: deps.rubric,
    tracker,
    emit,
  });
  const server = deps.buildServer(specs);
  const prompt = buildSystemPrompt(input.brief, deps.rubric);

  const q = deps.query({
    prompt,
    options: {
      model: deps.model ?? "claude-opus-4-8",
      mcpServers: { autocut: server },
      allowedTools,
      permissionMode: "bypassPermissions",
      maxTurns: caps.maxTurns,
      maxBudgetUsd: caps.maxBudgetUsd,
    },
  });

  let timedOut = false;
  const timer = setTimer(caps.wallclockMs, () => {
    timedOut = true;
    q.close();
  });

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const t = extractText(msg);
        if (t) emit({ iteration: tracker.iterations, phase: "plan", message: t.slice(0, 280) });
      }
      if (msg.type === "result") {
        const subtype = timedOut ? "wallclock" : msg.subtype ?? "success";
        return tracker.summarize(String(subtype));
      }
    }
    return tracker.summarize(timedOut ? "wallclock" : "success");
  } finally {
    timer.clear();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS (all existing loop tests + new agent tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent/session.ts src/agent/session.test.ts
git commit -m "feat(agent): runAgentSession glue (query + caps fence + stream → events)"
```

---

## Task 7: Real SDK seam (`sdk.ts`)

**Files:**
- Create: `src/agent/sdk.ts`

No unit test — this is the sealed entry that imports the SDK (mirrors `agent-server.ts` `main`, which is also untested). Verified by typecheck + the Daytona integration run (Task 10).

- [ ] **Step 1: Write the implementation**

Create `src/agent/sdk.ts`:
```ts
/**
 * The ONLY file that imports @anthropic-ai/claude-agent-sdk.
 *
 * Dynamic import keeps the rest of src/agent/ (and its tests) SDK-free and
 * offline, exactly like agent-server.ts dynamically imports @supabase/supabase-js
 * at its entry point. Provides the real `query` and `buildServer` that
 * runAgentSession injects in production.
 */
import type { QueryFn, QueryHandle } from "./session.js";
import type { ToolSpec } from "./tools.js";

/** Real `query`: adapt the SDK's AsyncGenerator (with .interrupt/.close) to QueryHandle. */
export async function makeRealQuery(): Promise<QueryFn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => {
    const q = query(params as never) as AsyncGenerator<unknown> & {
      close?: () => void;
      interrupt?: () => Promise<void>;
    };
    const handle = q as unknown as QueryHandle;
    // Normalize cancellation onto close(): prefer the SDK's close(), fall back to interrupt().
    if (typeof q.close !== "function") {
      (handle as { close: () => void }).close = () => {
        void q.interrupt?.();
      };
    }
    return handle;
  };
}

/** Real `buildServer`: turn our SDK-agnostic specs into an in-process MCP server. */
export async function makeRealBuildServer(): Promise<(specs: ToolSpec[]) => unknown> {
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  return (specs: ToolSpec[]) =>
    createSdkMcpServer({
      name: "autocut",
      tools: specs.map((s) => tool(s.name, s.description, s.schema, s.handler as never)),
    });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If the SDK's `query`/`tool` signatures reject the `as never` casts, adjust the cast site to match the installed types (the runtime shape is confirmed by Task 1 Step 2); do not change the public `QueryFn`/`ToolSpec` contracts.

- [ ] **Step 3: Commit**

```bash
git add src/agent/sdk.ts
git commit -m "feat(agent): sealed SDK seam (real query + buildServer)"
```

---

## Task 8: Wire `executeRun` to the agent session

**Files:**
- Modify: `src/server/agent-server.ts` (imports L36–52, `ExecuteRunOptions` L81–92, `executeRun` body L116–179, `main` L256–283, header comment L1–35)
- Modify: `src/server/server.test.ts` (L21 import, the `executeRun` describe ~L290–330)

- [ ] **Step 1: Update the `executeRun` test to inject a `runSession` stub**

In `src/server/server.test.ts`, replace the line `import { makeStubDeps } from "../loop/stubs.js";` with:
```ts
import { SAMPLE_LIBRARY, VIRAL_RUBRIC } from "../loop/stubs.js";
import type { LoopResult } from "../loop/controller.js";
```
Then, in the `executeRun` test(s), replace the `makeDeps: (emit) => makeStubDeps({ emit, ... })` option with a `runSession` stub that emits a couple of events and returns a passing `LoopResult`:
```ts
const runSession = async (
  _input: { brief: string; rubric: typeof VIRAL_RUBRIC },
  emit: (e: import("../loop/types.js").LoopEvent) => void,
): Promise<LoopResult> => {
  emit({ iteration: 1, phase: "render", message: "rendered", renderRef: "storage://renders/r1.mp4", ts: 0 });
  emit({ iteration: 1, phase: "grade", message: "graded 5/5", ts: 0 });
  return {
    passed: true,
    iterations: 1,
    stopReason: "passed",
    shipped: {
      render: { renderId: "r1", output: "storage://renders/r1.mp4", usedFallback: false },
      grade: {
        renderId: "r1",
        scores: { hook_strength: 8, pace_cut_density: 9, caption_legibility: 8, loopability: 8, on_style_trend_fit: 9 },
        feedback: {},
      },
      iteration: 1,
    },
  };
};
```
Pass `{ memoryDir, runSession }` into `executeRun(...)` where the test previously passed `makeDeps`. Keep all existing assertions (events streamed, status → shipped, memory rule written).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/server.test.ts`
Expected: FAIL — `executeRun` does not accept `runSession` yet (TS error or runtime: it still calls `runLoop`).

- [ ] **Step 3: Update `src/server/agent-server.ts`**

(a) Replace the loop imports (currently L36–41 region) — remove the `runLoop`/`makeStubDeps`/`createLoopDeps`/`AnthropicClient` lines and add:
```ts
import type { Rubric } from "../loop/controller.js";
import type { LoopResult } from "../loop/controller.js";
import type { LoopEvent, ClipLibrary } from "../loop/types.js";
import { SAMPLE_LIBRARY, VIRAL_RUBRIC } from "../loop/stubs.js";
import { runAgentSession } from "../agent/session.js";
import { makeStubToolImpls } from "../agent/tools.js";
```
Keep the existing `events`, `runs`, and `memory` imports.

(b) Replace the `makeDeps` field in `ExecuteRunOptions` (L84–85) with a `runSession` seam:
```ts
  /** Run one agent session for a run; defaults to the real Agent SDK session. */
  runSession?: (
    input: { brief: string; rubric: Rubric; library: ClipLibrary },
    emit: (e: LoopEvent) => void,
  ) => Promise<LoopResult>;
```

(c) In `executeRun`, replace the deps/`runLoop` block (currently L144–153) with:
```ts
  const runSession = opts.runSession ?? defaultRunSession;
  const result = await runSession({ brief: input.brief, rubric, library: input.library }, emit);
```
Leave everything after it (`shippedRef`, distill, upload, status) unchanged — it already reads `result.passed` / `result.shipped`.

(d) Add the default real session near the bottom of the file (above `main`):
```ts
/** Default session: the autonomous Agent SDK run with the selected tool impls. */
async function defaultRunSession(
  input: { brief: string; rubric: Rubric; library: ClipLibrary },
  emit: (e: LoopEvent) => void,
): Promise<LoopResult> {
  const { makeRealQuery, makeRealBuildServer } = await import("../agent/sdk.js");
  const real = process.env.AGENT_TOOLS === "real";
  if (real) {
    // Real tool impls (ffmpeg/Remotion/verifier) are out of scope for this milestone.
    throw new Error("AGENT_TOOLS=real not implemented yet — set AGENT_TOOLS=stub");
  }
  return runAgentSession(
    { brief: input.brief },
    {
      query: await makeRealQuery(),
      buildServer: await makeRealBuildServer(),
      toolImpls: makeStubToolImpls(),
      rubric: input.rubric,
      library: input.library,
      emit,
    },
  );
}
```

(e) In `main` (L256–283), delete the `RENDER_MODE`/`createLoopDeps`/`makeStubDeps` branch and the `makeDeps` option. Replace the `opts` object's `makeDeps` with nothing (executeRun now defaults to `defaultRunSession`), and change the log line + the `real` read:
```ts
  const tools = process.env.AGENT_TOOLS === "real" ? "real" : "stub";
  const opts: ExecuteRunOptions = {
    memoryDir,
    storage,
    readRender: async (ref) => {
      try {
        const { readFile } = await import("node:fs/promises");
        return new Uint8Array(await readFile(ref));
      } catch {
        return null;
      }
    },
  };
  console.log(`[agent] online — AGENT_TOOLS=${tools}, MEMORY_DIR=${memoryDir}`);
```

(f) Update the header comment (L1–35): change "run the tested self-correction loop" → "run the autonomous agent session", and replace the `runLoop(input, deps, {maxIters:4, passThreshold:7})` line in the ASCII diagram with `runAgentSession(input, {query, tools, caps}) — Claude drives; caps fence`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. (`src/loop/**` tests still green — the library is untouched.)

- [ ] **Step 6: Commit**

```bash
git add src/server/agent-server.ts src/server/server.test.ts
git commit -m "feat(agent): executeRun drives runAgentSession; RENDER_MODE -> AGENT_TOOLS"
```

---

## Task 9: Reconcile docs & config with the new live path

From the read-only audit. These are prose/config truths that the migration makes false. **Only the (A) must-update items** — `src/loop/**` stays accurate and is NOT touched.

**Files:**
- Modify: `package.json` (L6)
- Modify: `docs/architecture-flow.html` (L146, L212, L216, L217, L245–255, L287, L310, L315)
- Modify: `docs/loop-controller-spec.html` (add banner near L129)
- `.env.example` (the `RENDER_MODE` line → `AGENT_TOOLS`)

- [ ] **Step 1: `package.json` description**

Replace L6:
```
  "description": "Autonomous AI video editor — self-correction loop controller (task #1)",
```
with:
```
  "description": "Autonomous AI video editor — autonomous Claude Agent SDK session on Daytona, fenced by deterministic caps",
```

- [ ] **Step 2: `.env.example`**

Replace the `RENDER_MODE=stub ...` line with:
```
AGENT_TOOLS=stub               # stub (real Claude brain, fake render/grade tools) | real (not yet implemented)
```
Add a line noting `ANTHROPIC_API_KEY` is now required for the agent service (not only integration tests).

- [ ] **Step 3: `docs/architecture-flow.html` — replace the 8 audited spots**

For each, change the claim that the deterministic `loop/` controller is the live engine to the Agent SDK session fenced by caps. Concretely:
- L146 "a deterministic JS dynamic-workflow controller runs the self-correction loop" → "an autonomous Claude Agent SDK session runs the self-correction loop; deterministic caps fence it".
- L212 "This is where the long-horizon loop actually runs." → keep, but ensure the surrounding label points at the agent session, not `loop/`.
- L216 badge "loop/ — dynamic workflow controller (deterministic JS)" → "agent/ — autonomous Agent SDK session (Claude drives; caps fence)".
- L217 "A JS `while` loop owns termination — not the agent free-running on `/goal`." → "Claude owns iteration; the harness owns termination via maxTurns + maxBudgetUsd + wall-clock close() — never a free-running /goal with no cap."
- L245–255 gates + "the controller writes events / grades rows" → "the harness watches the SDK stream and writes events / grades rows".
- L287 "controller writes → UI subscribes" → "harness stream-watch writes → UI subscribes".
- L310 "Dynamic workflow = the `loop/` controller … Owns caps, best-so-far, and the … cycle." → "Autonomous session = `agent/`. Claude owns the build→render→grade→fix cycle; the harness owns caps + best-so-far."
- L315 "Termination is trustworthy because the loop logic is code, not a vibe." → "Termination is trustworthy because the caps are code (maxTurns/maxBudgetUsd/wall-clock), even though the agent drives."

- [ ] **Step 4: `docs/loop-controller-spec.html` — add a retired-engine banner**

Immediately after the opening `<div class="wrap">` (around L127), insert:
```html
  <div style="border:1.5px solid #9A6B1E;background:rgba(154,107,30,.08);border-radius:10px;padding:12px 16px;margin:0 0 24px;font-size:13px;color:#22211D">
    <b>Retired from the live path</b> as of the Agent SDK migration. This describes the deterministic engine,
    now kept as a tested library + fallback. For the live design see
    <a href="loop-vs-agent-spec.html">loop-vs-agent-spec.html</a>.
  </div>
```

- [ ] **Step 5: Verify no stale live-path claims remain**

Run:
```bash
grep -rn "RENDER_MODE" src .env.example docs *.json 2>/dev/null | grep -v node_modules
grep -rn "runLoop" src/server docs 2>/dev/null
```
Expected: `RENDER_MODE` appears nowhere outside historical contexts; `runLoop` appears only under `src/loop/**` (the retained library), not in `src/server` or as a live claim in `docs/`.

- [ ] **Step 6: Commit**

```bash
git add package.json .env.example docs/architecture-flow.html docs/loop-controller-spec.html
git commit -m "docs: reconcile references to the retired loop path"
```

---

## Task 10: Daytona stub-tools integration run (acceptance)

**Files:**
- Create: `docs/daytona-stub-test.md` (the runbook; the test itself is manual against live Supabase + Daytona)

- [ ] **Step 1: Write the runbook**

Create `docs/daytona-stub-test.md` capturing §5 of the spec:
```markdown
# Daytona stub-tools integration run

Prereqs (laptop): `supabase link && supabase db push` (tables + Realtime + renders bucket).
Grab SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the dashboard.

Sandbox:
1. Daytona sandbox from this repo; Node >= 20.
2. `npm install`.
3. Export env (the worker reads process.env; it does NOT load .env):
   export ANTHROPIC_API_KEY=...        # headless auth for the Agent SDK
   export SUPABASE_URL=...
   export SUPABASE_SERVICE_ROLE_KEY=...
   export MEMORY_DIR=/workspace/memory # persistent volume
   export AGENT_TOOLS=stub
   mkdir -p /workspace/memory
4. `npm run agent` → expect "[agent] online — AGENT_TOOLS=stub" + "runs subscription: SUBSCRIBED".
5. Insert a queued run (UI Generate, or SQL):
   insert into runs (brief, style, status) values ('Make a Viral Short from the library.', 'Viral Short', 'queued');
6. Watch: events stream (select → build → render → grade → ship), runs.status → shipped, UI feed updates.
7. Restart-safety: insert while the worker is down, start it, confirm reclaimQueued sweeps it.

Pass criteria: a run goes queued → running → shipped with a non-empty events trail and a render_ref,
driven entirely by the autonomous agent (no deterministic loop on the path).
```

- [ ] **Step 2: De-risk the SDK in the sandbox early**

In the sandbox, before a full run:
```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(m=>console.log('sdk ok', typeof m.query))"
```
Expected: `sdk ok function`. If the SDK needs the `claude` runtime/credentials beyond `ANTHROPIC_API_KEY`, resolve here (this is the spec's flagged risk).

- [ ] **Step 3: Execute the run and capture evidence**

Follow the runbook. Capture: the `[agent] online` log, the streamed `events` rows for the run, and the final `runs.status = shipped`.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/daytona-stub-test.md
git commit -m "docs: Daytona stub-tools integration runbook"
```

---

## Self-Review

**Spec coverage:**
- §2 decisions → Tasks 1–8 (Agent SDK, stub-tools, src/agent/, keep controller). ✓
- §4.1 tools.ts → Tasks 2, 4. ✓ §4.2 session.ts → Task 6. ✓ §4.3 caps backstop → Tasks 3 (subtype map) + 6 (maxTurns/maxBudgetUsd/wall-clock). ✓ §4.4 executeRun + env → Task 8. ✓ §4.5 retired-but-tested → `src/loop/**` untouched, verified Task 8 Step 5. ✓
- §5 Daytona prep → Task 10. ✓
- §6 references to reconcile → Task 9 (exact audited lines). ✓
- §7 testing → every code task is TDD; `src/loop/**` tests stay green. ✓
- §8 risks → Task 10 Step 2 de-risks the SDK in-sandbox; `maxBudgetUsd` default 0.5 in DEFAULT_CAPS; grade-before-publish enforced in the prompt (Task 5) + verdict text (Task 4). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; doc edits quote exact old→new text. The one deliberate runtime guard — `AGENT_TOOLS=real` throws "not implemented" — is intentional scope-fencing, surfaced loudly, not a silent stub. ✓

**Type consistency:** `ToolImpls`, `ToolSpec`, `Tracker`, `runAgentSession`, `QueryFn`/`QueryHandle`/`SdkMessage`, `AgentSessionDeps`, `LoopResult` used identically across Tasks 2–8. `createAutocutTools` returns `{ specs, allowedTools }` everywhere it's called. `Rubric` imported from `../loop/controller.js` consistently (Task 5 notes the verify-and-adjust if it's re-exported elsewhere). Stub grade script matches `loop/stubs.ts` (weak→pass). ✓
