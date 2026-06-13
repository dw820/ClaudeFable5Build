/**
 * Run lifecycle writers for the Supabase bus (plan Component 1).
 *
 * The UI inserts a `runs` row (status='queued'); the agent claims it atomically,
 * streams events, then marks it shipped/failed. `claimRun` is the double-execution
 * guard: a conditional UPDATE that only one caller can win.
 *
 * Mirrors the injected thin-surface pattern from src/preprocess/pgvector.ts — we
 * depend only on the query-builder slices each call needs, so the unit test mocks
 * those shapes and nothing connects at import time.
 */

/** Possible run lifecycle states (mirrors the migration's status comment). */
export type RunStatus = "queued" | "running" | "shipped" | "failed";

export interface RunInput {
  projectId?: string;
  brief?: string;
  style?: string;
  aspect?: string;
  targetLenS?: number;
}

/** A run row as read back from Supabase (snake_case columns). */
export interface RunRow {
  id: string;
  project_id?: string | null;
  brief?: string | null;
  style?: string | null;
  aspect?: string | null;
  target_len_s?: number | null;
  status: string;
  claimed_at?: string | null;
  shipped_render?: string | null;
}

interface SelectSingleResult<T> {
  data: T | null;
  error: { message: string } | null;
}
interface SelectListResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}
interface MutateResult {
  error: { message: string } | null;
}

/** The thin Supabase surface the run writers need. */
export interface InsertBuilder {
  insert(rows: object[]): {
    select(columns?: string): {
      single(): Promise<SelectSingleResult<{ id: string }>>;
    };
  };
}
export interface UpdateBuilder {
  /** updateRunStatus: `update(...).eq('id', runId)` → result. */
  update(values: object): {
    eq(column: string, value: string): Promise<MutateResult>;
  };
}
export interface ClaimBuilder {
  /** claimRun: `update(...).eq('id', runId).eq('status', 'queued').select()` → rows. */
  update(values: object): {
    eq(
      column: string,
      value: string,
    ): {
      eq(
        column: string,
        value: string,
      ): {
        select(columns?: string): Promise<SelectListResult<{ id: string }>>;
      };
    };
  };
}
export interface SelectBuilder {
  select(columns?: string): {
    eq(column: string, value: string): Promise<SelectListResult<RunRow>>;
  };
}

/** Per-operation client surfaces (thin, à la pgvector) — a full client satisfies all. */
export interface CreateRunClient {
  from(table: "runs"): InsertBuilder;
}
export interface UpdateRunClient {
  from(table: string): UpdateBuilder;
}
export interface ClaimRunClient {
  from(table: string): ClaimBuilder;
}
export interface SelectRunsClient {
  from(table: string): SelectBuilder;
}
/** The union of every run-writer surface (the real client implements all). */
export interface RunsClient {
  from(table: "runs"): InsertBuilder & UpdateBuilder & ClaimBuilder & SelectBuilder;
}

/** Map a RunInput to the `runs` insert row shape (queued by default in SQL). */
export function runInsertRow(input: RunInput): object {
  return {
    project_id: input.projectId ?? null,
    brief: input.brief ?? null,
    style: input.style ?? null,
    aspect: input.aspect ?? null,
    target_len_s: input.targetLenS ?? null,
  };
}

/** Insert a queued run, returning its generated id. */
export async function createRun(
  client: CreateRunClient,
  input: RunInput,
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("runs")
    .insert([runInsertRow(input)])
    .select("id")
    .single();
  if (error) throw new Error(`createRun failed: ${error.message}`);
  if (!data) throw new Error("createRun returned no row");
  return { id: data.id };
}

/** Update a run's status (and optionally the shipped render URL). */
export async function updateRunStatus(
  client: UpdateRunClient,
  runId: string,
  status: RunStatus,
  shippedRender?: string,
): Promise<void> {
  const values: { status: RunStatus; shipped_render?: string } = { status };
  if (shippedRender !== undefined) values.shipped_render = shippedRender;
  const { error } = await client.from("runs").update(values).eq("id", runId);
  if (error) throw new Error(`updateRunStatus failed: ${error.message}`);
}

/**
 * Atomically claim a run: `update runs set status='running', claimed_at=now()
 * where id=? and status='queued'` returning the rows that matched. Because the
 * `status='queued'` predicate is part of the conditional update, exactly one
 * caller transitions the row — the winner gets a row back, losers get none.
 */
export async function claimRun(
  client: ClaimRunClient,
  runId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("runs")
    .update({ status: "running", claimed_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("status", "queued")
    .select("id");
  if (error) throw new Error(`claimRun failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Select every still-queued run (used on boot to reclaim orphans). */
export async function queuedRuns(client: SelectRunsClient): Promise<RunRow[]> {
  const { data, error } = await client.from("runs").select("*").eq("status", "queued");
  if (error) throw new Error(`queuedRuns failed: ${error.message}`);
  return data ?? [];
}
