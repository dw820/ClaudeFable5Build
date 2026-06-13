# Daytona stub-tools integration run

The acceptance test for the autonomous-agent-on-Daytona migration. It proves the
full bus — UI/Supabase → agent worker → autonomous Claude session → events stream
→ render delivered — with **stub tools** (real Claude brain, fake `render`/`grade`/
`search` so there is no ffmpeg/Remotion/Replicate dependency yet).

## Prereqs (laptop, once)

```bash
supabase link            # link to the remote project
supabase db push         # applies 0001_runs_events.sql → tables + Realtime + renders bucket
supabase migration list  # confirm 0001 applied on remote
```

From the Supabase dashboard (Settings → API), grab:
- `SUPABASE_URL` (Project URL)
- `SUPABASE_SERVICE_ROLE_KEY` (the **service_role** secret — not the anon key)

## Provision Daytona

Get an API key first: sign up at [app.daytona.io](https://app.daytona.io), then
**Keys → Create Key** (copy it — shown once). Then pick a path.

### Option A — one command (SDK, recommended)

`scripts/daytona-provision.ts` does the whole thing from your laptop: gets/creates the
volume, creates a sandbox with **all secrets baked into `envVars`** (so the worker — which
reads `process.env`, not `.env` — just sees them), clones the branch, `npm install`s, runs
the SDK de-risk check, then starts `npm run agent` and streams its logs to your terminal.

```bash
# add DAYTONA_API_KEY to .env (the other secrets are already there), then:
npm run provision:daytona
```

Reads from `.env`: `DAYTONA_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. Optional overrides: `GITHUB_TOKEN` (private clone),
`REPO_BRANCH`, `DAYTONA_SNAPSHOT`, `DAYTONA_SANDBOX_NAME`, `AGENT_TOOLS`.
Ctrl-C detaches the log stream; the sandbox keeps running and auto-stops after 60 min idle.
Skip straight to **Pass criteria** once you see `runs subscription: SUBSCRIBED`.

### Option B — CLI + setup script (no SDK)

1. **Install + auth the CLI:**
   ```bash
   brew install daytonaio/cli/daytona && brew trust daytonaio/cli   # macOS
   daytona login                                                    # or: export DAYTONA_API_KEY=<key>
   ```
2. **Volume + sandbox:**
   ```bash
   daytona volume create autocut-memory
   daytona create --name autocut --volume autocut-memory:/workspace/memory
   ```
   Add `--snapshot daytona-medium` if you hit resource limits. The default
   `daytonaio/sandbox` image (0.8.0) ships **Node 25 via nvm** as user `daytona`
   (home `/home/daytona`), so Node is already ≥ 20 — no install needed.
3. **Shell in and run the setup script** — ensures Node ≥ 20, clones the branch,
   `npm install`s, writes a `.daytona.env` template, runs the SDK de-risk check:
   ```bash
   daytona ssh autocut
   curl -fsSL https://raw.githubusercontent.com/dw820/ClaudeFable5Build/feat/autonomous-agent-daytona/scripts/daytona-setup.sh | bash
   cd ~/autocut && $EDITOR .daytona.env   # paste keys, then: source .daytona.env && npm run agent
   ```

The manual breakdown below applies to Option B (Option A automates all of it).

Or do it by hand:

1. Create a Daytona sandbox from this repo; Node **≥ 20**.
2. `npm install`.
3. Export env (the worker reads `process.env` directly — it does **not** auto-load `.env`):
   ```bash
   export ANTHROPIC_API_KEY=...         # headless auth for the Agent SDK — the brain is real Claude
   export SUPABASE_URL=...
   export SUPABASE_SERVICE_ROLE_KEY=...
   export MEMORY_DIR=/workspace/memory  # persistent volume → file memory survives restarts
   export AGENT_TOOLS=stub
   mkdir -p /workspace/memory
   ```
4. **De-risk the SDK first** (the spec's flagged risk — confirm the SDK runs headless on the image):
   ```bash
   node -e "import('@anthropic-ai/claude-agent-sdk').then(m=>console.log('sdk ok', typeof m.query))"
   ```
   Expected: `sdk ok function`. If the SDK needs the `claude` runtime/credentials beyond
   `ANTHROPIC_API_KEY`, resolve that here before a full run.
5. Start the worker:
   ```bash
   npm run agent
   ```
   Expected logs:
   ```
   [agent] online — AGENT_TOOLS=stub, MEMORY_DIR=/workspace/memory
   [agent] runs subscription: SUBSCRIBED
   ```
   `SUBSCRIBED` proves Realtime is reachable and the publication is set up.
6. Insert a queued run (UI "Generate", or SQL in the Supabase editor):
   ```sql
   insert into runs (brief, style, status)
   values ('Make a Viral Short from the library.', 'Viral Short', 'queued');
   ```
7. Watch it work:
   - `events` rows stream for the run (`memory` → `select` → `build` → `render` → `grade` → `ship`),
   - `runs.status` flips `queued → running → shipped`,
   - the UI live feed updates.
8. Restart-safety: insert a run while the worker is stopped, then start it — `reclaimQueued`
   should sweep it up on boot.

## Pass criteria

A run goes `queued → running → shipped` with a non-empty `events` trail and a
`render_ref`, driven entirely by the autonomous agent (the deterministic `loop/`
controller is **not** on the path). If a cap trips before the agent calls `publish`,
the run still ships the best-so-far render (status may be `failed` with a `render_ref`,
never empty).

## Next (out of scope here — Phase 3)

Flip `AGENT_TOOLS=real` and wire the real tool impls one at a time (`src/edit/cut.ts`,
`src/render/render.ts`, the verifier in `src/verify/grade.ts`), plus install ffmpeg and
the Remotion headless Chromium in the sandbox. The agent and harness do not change —
only the injected tool implementations do.
