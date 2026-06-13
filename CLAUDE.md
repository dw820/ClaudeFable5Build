# CLAUDE.md

## Supabase: DB migrations

Migrations live in `supabase/migrations/` (e.g. `0001_runs_events.sql`).

```bash
# Push local migrations to the linked remote database
supabase db push                    # apply all pending migrations
supabase db push --dry-run          # preview what would run, no changes
supabase db push --include-all      # include migrations out of version order

# Create a new migration
supabase migration new <name>       # adds a timestamped file in supabase/migrations/

# Inspect migration state
supabase migration list             # compare local vs remote applied migrations

# Local dev DB (Docker)
supabase start                      # start local stack
supabase db reset                   # rebuild local DB, re-run all migrations + seed
supabase stop                       # stop local stack
```

Notes:
- `supabase db push` targets the **remote linked** project. Run `supabase link` first.
- The project `<ref>` is in your Supabase dashboard URL: `app.supabase.com/project/<ref>`.
- Set `SUPABASE_DB_PASSWORD` (or pass `--password`) for non-interactive pushes in CI.
