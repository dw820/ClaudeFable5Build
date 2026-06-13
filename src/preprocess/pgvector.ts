/**
 * Upsert clip embeddings to Supabase pgvector (OFF the demo path, but wired +
 * tested). The Supabase client is INJECTED so the unit test mocks it and
 * nothing connects at import time.
 *
 * We depend only on the `from(table).upsert(rows)` slice of the client, so the
 * mock surface is a two-method shape rather than the whole SupabaseClient.
 */

/** The minimal Supabase surface the upsert needs. */
export interface UpsertResult {
  error: { message: string } | null;
}
export interface PgvectorTable {
  upsert(
    rows: object[],
    options?: { onConflict?: string },
  ): Promise<UpsertResult>;
}
export interface SupabaseLike {
  from(table: string): PgvectorTable;
}

export interface ClipEmbedding {
  clipId: string;
  projectId: string;
  embedding: number[];
  caption: string;
}

export interface UpsertOptions {
  /** Target table (default "clip_embeddings"). */
  table?: string;
}

/** Map a ClipEmbedding to the row shape the pgvector table expects. */
export function embeddingRow(e: ClipEmbedding): object {
  return {
    clip_id: e.clipId,
    project_id: e.projectId,
    caption: e.caption,
    embedding: e.embedding,
  };
}

/**
 * Upsert embeddings, keyed on clip_id so re-running preprocess is idempotent.
 * Throws on a Supabase error so a failed index doesn't pass silently.
 */
export async function upsertEmbeddings(
  client: SupabaseLike,
  embeddings: ClipEmbedding[],
  opts: UpsertOptions = {},
): Promise<void> {
  if (embeddings.length === 0) return;
  const table = opts.table ?? "clip_embeddings";
  const rows = embeddings.map(embeddingRow);
  const { error } = await client.from(table).upsert(rows, {
    onConflict: "clip_id",
  });
  if (error) {
    throw new Error(`pgvector upsert failed: ${error.message}`);
  }
}
