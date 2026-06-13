/**
 * Agent-service unit suite (offline — mock Supabase clients + temp MEMORY_DIR).
 * Covers the event mapper, the fire-and-forget emit, the atomic claim win/lose,
 * status transitions, and an executeRun happy path that asserts events streamed,
 * status → shipped, and a memory rule was written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventRow, makeSupabaseEmit, type SupabaseInsert } from "./events.js";
import {
  createRun,
  updateRunStatus,
  claimRun,
  runInsertRow,
  type RunsClient,
} from "./runs.js";
import { executeRun, type AgentClient } from "./agent-server.js";
import { consult, styleDir } from "../memory/index.js";
import { SAMPLE_LIBRARY, VIRAL_RUBRIC } from "../loop/stubs.js";
import type { LoopResult } from "../loop/controller.js";
import type { LoopEvent } from "../loop/types.js";

/**
 * A `runSession` stub matching the seam executeRun injects: emits a couple of
 * events and returns a passing LoopResult. Signature mirrors ExecuteRunOptions.
 */
const passingRunSession = async (
  _input: { brief: string; rubric: typeof VIRAL_RUBRIC; library: typeof SAMPLE_LIBRARY },
  emit: (e: LoopEvent) => void,
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

/* ------------------------------- events -------------------------------- */

describe("eventRow", () => {
  it("maps a LoopEvent to the events table columns", () => {
    const e: LoopEvent = {
      iteration: 2,
      phase: "grade",
      message: "graded 5/5",
      scores: {
        hook_strength: 8,
        pace_cut_density: 9,
        caption_legibility: 8,
        loopability: 8,
        on_style_trend_fit: 9,
      },
      renderRef: "storage://renders/r2.mp4",
      ts: 123,
    };
    expect(eventRow("run-1", e)).toEqual({
      run_id: "run-1",
      iteration: 2,
      phase: "grade",
      message: "graded 5/5",
      scores: e.scores,
      render_ref: "storage://renders/r2.mp4",
      ts: 123,
    });
  });

  it("nulls absent scores / renderRef", () => {
    const e: LoopEvent = { iteration: 1, phase: "build", message: "building", ts: 5 };
    expect(eventRow("run-1", e)).toMatchObject({ scores: null, render_ref: null });
  });
});

describe("makeSupabaseEmit", () => {
  it("inserts one row per event (fire-and-forget)", async () => {
    const inserts: object[][] = [];
    const client: SupabaseInsert = {
      from: () => ({
        async insert(rows) {
          inserts.push(rows);
          return { error: null };
        },
      }),
    };
    const emit = makeSupabaseEmit(client, "run-1");
    emit({ iteration: 1, phase: "build", message: "a", ts: 1 });
    emit({ iteration: 1, phase: "render", message: "b", ts: 2 });
    await Promise.resolve(); // let the fire-and-forget promises settle

    expect(inserts).toHaveLength(2);
    expect(inserts[0]![0]).toMatchObject({ run_id: "run-1", phase: "build" });
    expect(inserts[1]![0]).toMatchObject({ run_id: "run-1", phase: "render" });
  });

  it("logs and does not throw when the insert errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client: SupabaseInsert = {
      from: () => ({
        async insert() {
          return { error: { message: "boom" } };
        },
      }),
    };
    const emit = makeSupabaseEmit(client, "run-1");
    expect(() => emit({ iteration: 1, phase: "build", message: "a", ts: 1 })).not.toThrow();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("boom"));
    spy.mockRestore();
  });
});

/* -------------------------------- runs --------------------------------- */

describe("runInsertRow", () => {
  it("maps RunInput to snake_case columns with nulls for gaps", () => {
    expect(runInsertRow({ brief: "hi", style: "Viral Short" })).toEqual({
      project_id: null,
      brief: "hi",
      style: "Viral Short",
      aspect: null,
      target_len_s: null,
    });
  });
});

describe("createRun", () => {
  it("inserts and returns the generated id", async () => {
    const client: RunsClient = {
      from: () =>
        ({
          insert: () => ({
            select: () => ({
              async single() {
                return { data: { id: "uuid-1" }, error: null };
              },
            }),
          }),
        }) as never,
    };
    expect(await createRun(client, { brief: "x" })).toEqual({ id: "uuid-1" });
  });
});

describe("updateRunStatus", () => {
  it("sends status (+ shipped_render when provided) filtered by id", async () => {
    const calls: { values: object; col: string; val: string }[] = [];
    const client: RunsClient = {
      from: () =>
        ({
          update: (values: object) => ({
            async eq(col: string, val: string) {
              calls.push({ values, col, val });
              return { error: null };
            },
          }),
        }) as never,
    };
    await updateRunStatus(client, "run-1", "shipped", "https://cdn/r.mp4");
    expect(calls[0]).toEqual({
      values: { status: "shipped", shipped_render: "https://cdn/r.mp4" },
      col: "id",
      val: "run-1",
    });
  });

  it("omits shipped_render when not provided", async () => {
    let seen: object | null = null;
    const client: RunsClient = {
      from: () =>
        ({
          update: (values: object) => ({
            async eq() {
              seen = values;
              return { error: null };
            },
          }),
        }) as never,
    };
    await updateRunStatus(client, "run-1", "running");
    expect(seen).toEqual({ status: "running" });
  });
});

/** Mock the claim chain: update(...).eq('id').eq('status').select() → rows. */
function claimClient(returnedRows: { id: string }[]): RunsClient {
  return {
    from: () =>
      ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              async select() {
                return { data: returnedRows, error: null };
              },
            }),
          }),
        }),
      }) as never,
  };
}

describe("claimRun", () => {
  it("returns true when this caller's conditional update matched a row (win)", async () => {
    expect(await claimRun(claimClient([{ id: "run-1" }]), "run-1")).toBe(true);
  });
  it("returns false when no row matched — already claimed (lose)", async () => {
    expect(await claimRun(claimClient([]), "run-1")).toBe(false);
  });
});

/* ------------------------------ executeRun ----------------------------- */

/**
 * A mock AgentClient that records events streamed via insert and run status
 * mutations via update(...).eq('id'). executeRun is called on an already-claimed
 * run, so the claim chain isn't exercised here (see claimRun tests above).
 */
function makeAgentClient() {
  const events: object[] = [];
  const statuses: { status: string; shipped?: string }[] = [];

  const client: AgentClient = {
    from: () =>
      ({
        async insert(rows: object[]) {
          events.push(...rows);
          return { error: null };
        },
        update: (values: { status?: string; shipped_render?: string }) => ({
          async eq() {
            statuses.push({ status: values.status!, shipped: values.shipped_render });
            return { error: null };
          },
        }),
      }) as never,
  };
  return { client, events, statuses };
}

describe("executeRun", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "autocut-srv-"));
  });
  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it("happy path: streams events, ships, and distills a memory rule", async () => {
    const { client, events, statuses } = makeAgentClient();
    const run = {
      id: "run-1",
      style: "Viral Short",
      brief: "30s Viral Short, open on the wipeout",
      status: "running",
    };

    await executeRun(client, run, {
      memoryDir,
      // deterministic agent session that emits a couple of events and passes
      runSession: passingRunSession,
      now: () => 777,
    });

    // events streamed to the bus (consult note + session events)
    await Promise.resolve();
    const phases = events.map((e) => (e as { phase: string }).phase);
    expect(phases).toContain("memory"); // consult note
    expect(phases).toContain("render");
    expect(phases).toContain("grade");

    // run reached shipped with a render ref
    const last = statuses[statuses.length - 1]!;
    expect(last.status).toBe("shipped");
    expect(last.shipped).toMatch(/render/);

    // a verified rule was written to memory (outer loop)
    const files = await readdir(styleDir(memoryDir, "Viral Short"));
    expect(files).toContain("run-1.json");
    const rules = await consult(memoryDir, "Viral Short");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ source: "run-1", ts: 777 });
  });

  it("consults prior memory and notes the applied rules in the first event", async () => {
    const { client, events } = makeAgentClient();
    // seed one prior rule
    const { distill } = await import("../memory/index.js");
    await distill(
      memoryDir,
      "Viral Short",
      { id: "prior", style: "Viral Short" },
      {
        renderId: "r",
        scores: {
          hook_strength: 8,
          pace_cut_density: 8,
          caption_legibility: 8,
          loopability: 8,
          on_style_trend_fit: 8,
        },
        feedback: {},
      },
      1,
    );

    await executeRun(
      client,
      { id: "run-2", style: "Viral Short", brief: "b", status: "running" },
      { memoryDir, runSession: passingRunSession, now: () => 1 },
    );

    const consultEvent = events.find(
      (e) => (e as { phase: string }).phase === "memory" && (e as { iteration: number }).iteration === 0,
    ) as { message: string } | undefined;
    expect(consultEvent?.message).toContain("1 learned rule");
  });

  it("uploads the render to Storage when bytes are readable and ships the public URL", async () => {
    const { client, statuses } = makeAgentClient();
    const uploads: { path: string; contentType?: string }[] = [];
    const storage = {
      from: () => ({
        async upload(path: string, _body: unknown, options?: { contentType?: string }) {
          uploads.push({ path, contentType: options?.contentType });
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.example/renders/${path}` },
        }),
      }),
    };

    await executeRun(client, { id: "run-3", style: "Viral Short", brief: "b", status: "running" }, {
      memoryDir,
      runSession: passingRunSession,
      storage,
      readRender: async () => new Uint8Array([1, 2, 3]),
      now: () => 1,
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toBe("video/mp4");
    const last = statuses[statuses.length - 1]!;
    expect(last.status).toBe("shipped");
    expect(last.shipped).toBe("https://cdn.example/renders/run-3.mp4");
  });
});
