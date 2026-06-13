/**
 * Event writer for the Supabase bus (plan Component 1).
 *
 * The controller's `emit` is a SYNC `(e: LoopEvent) => void`, but a Supabase
 * insert is async — so `makeSupabaseEmit` returns a sync function that
 * fire-and-forgets the insert and logs on error. Ordering in the UI is preserved
 * by the serial `id` column + Realtime, not by awaiting here.
 *
 * Mirrors the injected thin-surface pattern from src/preprocess/pgvector.ts:
 * we depend only on the `from(table).insert(rows)` slice, so the unit test mocks
 * a two-method shape and nothing connects at import time.
 */
import type { LoopEvent } from "../loop/types.js";

/** The minimal Supabase surface the event insert needs. */
export interface InsertResult {
  error: { message: string } | null;
}
export interface InsertTable {
  insert(rows: object[]): Promise<InsertResult>;
}
export interface SupabaseInsert {
  from(table: string): InsertTable;
}

/** Map a LoopEvent to the row shape the `events` table expects. */
export function eventRow(runId: string, e: LoopEvent): object {
  return {
    run_id: runId,
    iteration: e.iteration,
    phase: e.phase,
    message: e.message,
    scores: e.scores ?? null,
    render_ref: e.renderRef ?? null,
    ts: e.ts,
  };
}

/**
 * Build the controller's `emit` sink: a sync void that fire-and-forgets an
 * insert into `events`. Errors are logged, never thrown — a dropped event must
 * not crash the loop.
 */
export function makeSupabaseEmit(
  client: SupabaseInsert,
  runId: string,
): (e: LoopEvent) => void {
  return (e: LoopEvent) => {
    void client
      .from("events")
      .insert([eventRow(runId, e)])
      .then(({ error }) => {
        if (error) {
          console.error(`[events] insert failed for run ${runId}: ${error.message}`);
        }
      })
      .catch((err: unknown) => {
        console.error(
          `[events] insert threw for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };
}
