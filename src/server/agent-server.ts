/**
 * AutoCut agent service — the long-lived Daytona worker (plan Component 2).
 *
 * It is the agent's persistent home: subscribe to new runs, claim them so no two
 * workers double-execute, run the autonomous agent session, learn across runs
 * via file memory, and deliver the finished cut back through Supabase.
 *
 *   ┌─────────── Supabase (the two-way bus) ───────────┐
 *   │  runs(INSERT) ──Realtime──▶                       │
 *   └───────────────────────────────────────────────────┘
 *                       │
 *                       ▼
 *   boot: reclaim queued ──▶ claimRun (queued→running, one winner)
 *                                   │ won?
 *                                   ▼
 *   memory.consult(MEMORY_DIR,style) ──▶ build session input (brief+rubric+rules)
 *                                   │
 *                                   ▼
 *   runAgentSession(input, {query, tools, caps}) — Claude drives; caps fence
 *        emit = makeSupabaseEmit(client, runId) ──Realtime──▶ events ──▶ UI
 *                                   │ pass?
 *                  ┌────────────────┴───────────────┐
 *                  ▼ yes                            ▼ no
 *      memory.distill(...)              (skip distill)
 *                  │                                │
 *                  ▼                                ▼
 *      upload render → Storage 'renders'   ship best-so-far ref
 *                  │                                │
 *                  ▼                                ▼
 *      updateRunStatus('shipped', url)   updateRunStatus('failed', bestRef)
 *
 * Sealed + restart-safe: the real @supabase/supabase-js client is constructed
 * ONLY at the entry point (`main`), never at import — so this file is importable
 * (and `executeRun` unit-testable) with no network and no env.
 */
import type { Rubric, LoopResult } from "../loop/controller.js";
import { SAMPLE_LIBRARY, VIRAL_RUBRIC } from "../loop/stubs.js";
import { runAgentSession } from "../agent/session.js";
import { makeStubToolImpls } from "../agent/tools.js";
import { PASS_THRESHOLD } from "../constants.js";
import type { LoopEvent, ClipLibrary } from "../loop/types.js";
import { makeSupabaseEmit, type InsertTable } from "./events.js";
import {
  claimRun,
  updateRunStatus,
  queuedRuns,
  type UpdateBuilder,
  type ClaimBuilder,
  type SelectBuilder,
  type RunRow,
} from "./runs.js";
import { consult, distill, DEFAULT_MEMORY_DIR } from "../memory/index.js";

/** The slice of a Supabase Storage bucket the agent uploads through. */
export interface StorageBucket {
  upload(
    path: string,
    body: ArrayBuffer | Uint8Array | Blob | string,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: { path: string } | null; error: { message: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
}
export interface StorageClient {
  from(bucket: string): StorageBucket;
}

/**
 * Everything the agent touches on the Supabase client (all injected/mockable).
 * `from('events')` streams events; `from('runs')` claims/updates/selects runs —
 * a single `from` whose result serves every builder the agent needs (it does not
 * createRun, so the insert→select chain isn't required here). Storage is optional.
 */
export interface AgentClient {
  from(table: string): InsertTable & UpdateBuilder & ClaimBuilder & SelectBuilder;
  storage?: StorageClient;
}

export interface ExecuteRunOptions {
  /** Memory root (persistent on Daytona; temp dir in tests). */
  memoryDir?: string;
  /** Run one agent session for a run; defaults to the real Agent SDK session. */
  runSession?: (
    input: { brief: string; rubric: Rubric; library: ClipLibrary },
    emit: (e: LoopEvent) => void,
  ) => Promise<LoopResult>;
  /** Storage client for uploading the shipped render (optional in tests). */
  storage?: StorageClient;
  /** Read the rendered bytes for upload. Defaults to a no-op (stub path). */
  readRender?: (ref: string) => Promise<Uint8Array | null>;
  /** Injectable clock for deterministic distill timestamps. */
  now?: () => number;
}

/** Resolve the rubric for a run's style (defaults to the Viral Short rubric). */
function rubricForStyle(style: string | null | undefined): Rubric {
  if (!style || style.trim() === "" || style === VIRAL_RUBRIC.style) return VIRAL_RUBRIC;
  return { style, passThreshold: PASS_THRESHOLD };
}

/** Compose the loop brief, noting any consulted memory rules so the run records them. */
function composeBrief(run: RunRow, rules: { text: string }[]): string {
  const base = run.brief?.trim() || "Make a Viral Short from the library.";
  if (rules.length === 0) return base;
  const notes = rules.map((r) => `- ${r.text}`).join("\n");
  return `${base}\n\nLearned from prior runs (memory):\n${notes}`;
}

/**
 * Execute one claimed run end-to-end. Kept separate from the subscribe callback
 * so it is unit-testable with a mock client + temp MEMORY_DIR.
 *
 * Always finishes the run: on pass → distill + upload + status 'shipped'; on a
 * capped/failed loop → status 'failed' but still records the best-so-far render
 * ref so the UI has something to show.
 */
export async function executeRun(
  client: AgentClient,
  run: RunRow,
  opts: ExecuteRunOptions = {},
): Promise<void> {
  const memoryDir = opts.memoryDir ?? DEFAULT_MEMORY_DIR;
  const now = opts.now ?? Date.now;
  const rubric = rubricForStyle(run.style);
  const emit = makeSupabaseEmit(client, run.id);

  // OUTER LOOP (consult): bias this run on what prior passes taught us.
  const rules = await consult(memoryDir, rubric.style);
  emit({
    iteration: 0,
    phase: "memory",
    message:
      rules.length > 0
        ? `Consulted memory: applying ${rules.length} learned rule(s)`
        : "Consulted memory: no prior rules for this style yet",
    ts: now(),
  });

  const input = {
    brief: composeBrief(run, rules),
    rubric,
    library: SAMPLE_LIBRARY as ClipLibrary,
  };

  const runSession = opts.runSession ?? defaultRunSession;

  try {
    const result = await runSession(
      { brief: input.brief, rubric: input.rubric, library: input.library },
      emit,
    );

    const shippedRef = result.shipped?.render.output;

    // OUTER LOOP (distill): only a real pass earns a verified rule.
    if (result.passed && result.shipped) {
      await distill(memoryDir, rubric.style, { id: run.id, style: rubric.style }, result.shipped.grade, now());
    }

    // Deliver the render: upload to Storage if we can read bytes, else keep the ref.
    let deliveredRef = shippedRef;
    if (shippedRef && opts.storage && opts.readRender) {
      const url = await uploadRender(opts.storage, run.id, shippedRef, opts.readRender);
      if (url) deliveredRef = url;
    }

    if (result.passed) {
      await updateRunStatus(client, run.id, "shipped", deliveredRef);
    } else {
      // Capped/failed: still ship the best-so-far ref so the UI isn't empty.
      await updateRunStatus(client, run.id, "failed", deliveredRef);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ iteration: 0, phase: "fix", message: `Run errored: ${message}`, ts: now() });
    await updateRunStatus(client, run.id, "failed");
  }
}

/** Upload the rendered file to the public `renders` bucket; return its URL or null. */
async function uploadRender(
  storage: StorageClient,
  runId: string,
  ref: string,
  readRender: (ref: string) => Promise<Uint8Array | null>,
): Promise<string | null> {
  const bytes = await readRender(ref);
  if (!bytes) return null;
  const path = `${runId}.mp4`;
  const bucket = storage.from("renders");
  const { error } = await bucket.upload(path, bytes, {
    contentType: "video/mp4",
    upsert: true,
  });
  if (error) {
    console.error(`[agent] render upload failed for run ${runId}: ${error.message}`);
    return null;
  }
  return bucket.getPublicUrl(path).data.publicUrl;
}

/**
 * Claim a queued run, then execute it if we won the claim. Used both by the boot
 * reclaim sweep and the Realtime INSERT handler — the atomic claim makes both
 * paths safe to call for the same run.
 */
export async function handleRun(
  client: AgentClient,
  run: RunRow,
  opts: ExecuteRunOptions = {},
): Promise<void> {
  let won = false;
  try {
    won = await claimRun(client, run.id);
  } catch (err) {
    console.error(
      `[agent] claim failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!won) return; // another worker (or an earlier sweep) owns it
  await executeRun(client, run, opts);
}

/** On boot, reclaim every still-queued run so a restart never strands work. */
export async function reclaimQueued(
  client: AgentClient,
  opts: ExecuteRunOptions = {},
): Promise<void> {
  const pending = await queuedRuns(client);
  for (const run of pending) {
    await handleRun(client, run, opts);
  }
}

/** Default session: the autonomous Agent SDK run with the selected tool impls. */
async function defaultRunSession(
  input: { brief: string; rubric: Rubric; library: ClipLibrary },
  emit: (e: LoopEvent) => void,
): Promise<LoopResult> {
  const { makeRealQuery, makeRealBuildServer } = await import("../agent/sdk.js");
  const real = process.env.AGENT_TOOLS === "real";

  let toolImpls = makeStubToolImpls();
  let library = input.library;

  if (real) {
    const { AnthropicClient } = await import("../llm/client.js");
    const { loadClipLibrary } = await import("../agent/realLibrary.js");
    const { makeRealToolImpls } = await import("../agent/realTools.js");
    // Real mode renders from the fixture library, not the stub SAMPLE_LIBRARY.
    library = await loadClipLibrary();
    toolImpls = makeRealToolImpls({
      llm: new AnthropicClient(),
      library,
      brief: input.brief,
      rubric: input.rubric,
    });
  }

  return runAgentSession(
    { brief: input.brief },
    {
      query: await makeRealQuery(),
      buildServer: await makeRealBuildServer(),
      toolImpls,
      rubric: input.rubric,
      library,
      emit,
    },
  );
}

/**
 * Entry point — the ONLY place a real @supabase/supabase-js client (and the real
 * render deps) are constructed. Imported modules stay network-free.
 */
async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to run the agent");
  }

  // Dynamic import so importing this file for tests never pulls in the SDK side effects.
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
  const client = supabase as unknown as AgentClient;
  const storage = supabase.storage as unknown as StorageClient;

  const memoryDir = process.env.MEMORY_DIR ?? DEFAULT_MEMORY_DIR;
  const tools = process.env.AGENT_TOOLS === "real" ? "real" : "stub";

  const opts: ExecuteRunOptions = {
    memoryDir,
    storage,
    readRender: async (ref) => {
      // On Daytona the render lands on the local FS; in stub mode there is no file.
      try {
        const { readFile } = await import("node:fs/promises");
        return new Uint8Array(await readFile(ref));
      } catch {
        return null;
      }
    },
  };

  console.log(`[agent] online — AGENT_TOOLS=${tools}, MEMORY_DIR=${memoryDir}`);

  // Restart-safe: sweep up anything queued while we were down.
  await reclaimQueued(client, opts);

  // Subscribe to new work. The atomic claim makes concurrent INSERT handlers safe.
  supabase
    .channel("runs-insert")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "runs" },
      (payload: { new: RunRow }) => {
        void handleRun(client, payload.new, opts);
      },
    )
    .subscribe((status: string) => {
      console.log(`[agent] runs subscription: ${status}`);
    });
}

// Run only when invoked directly (`tsx src/server/agent-server.ts`), never on import.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /agent-server\.(ts|js)$/.test(process.argv[1] ?? "");

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[agent] fatal:", err);
    process.exit(1);
  });
}
