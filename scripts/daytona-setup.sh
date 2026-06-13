#!/usr/bin/env bash
#
# daytona-setup.sh — provision a fresh Daytona sandbox for the stub-tools test.
#
# Run this INSIDE a sandbox shell (`daytona ssh <name>`) on the default image.
# It ensures Node >= 20, clones this repo, installs deps, and drops an env
# template you fill in before `npm run agent`. Idempotent — safe to re-run.
#
# Usage:
#   curl -fsSL <raw-url>/scripts/daytona-setup.sh | bash      # one-liner
#   ./scripts/daytona-setup.sh                                # if already cloned
#
# Then: edit ~/autocut/.daytona.env, `source` it, and `npm run agent`.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dw820/ClaudeFable5Build.git}"
REPO_BRANCH="${REPO_BRANCH:-feat/autonomous-agent-daytona}"
REPO_DIR="${REPO_DIR:-$HOME/autocut}"
MEMORY_DIR="${MEMORY_DIR:-/workspace/memory}"   # mount the persistent volume here
NODE_MAJOR=20

log() { printf '\n\033[1;36m[setup]\033[0m %s\n' "$*"; }

# 1. Node >= 20 ---------------------------------------------------------------
# The default daytonaio/sandbox image ships Node 25 via nvm, so the common path
# is "already fine". Only fall back to nvm if a custom image ships something old.
if command -v node >/dev/null 2>&1 && \
   [ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" -ge "$NODE_MAJOR" ]; then
  log "Node $(node -v) present — OK"
else
  log "Node missing or < $NODE_MAJOR — installing via nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR" && nvm alias default "$NODE_MAJOR"
  log "Installed $(node -v)"
fi

# 2. Repo ---------------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
  log "Repo already at $REPO_DIR — fetching $REPO_BRANCH"
  git -C "$REPO_DIR" fetch origin "$REPO_BRANCH"
  git -C "$REPO_DIR" checkout "$REPO_BRANCH"
  git -C "$REPO_DIR" pull --ff-only origin "$REPO_BRANCH"
else
  log "Cloning $REPO_URL ($REPO_BRANCH) -> $REPO_DIR"
  git clone -b "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
fi

# 3. Dependencies -------------------------------------------------------------
log "npm install"
( cd "$REPO_DIR" && npm install )

# 4. Persistent memory dir ----------------------------------------------------
mkdir -p "$MEMORY_DIR"
log "MEMORY_DIR ready at $MEMORY_DIR"

# 5. Env template -------------------------------------------------------------
ENV_FILE="$REPO_DIR/.daytona.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# Fill in, then: source .daytona.env  (the worker reads process.env directly)
export ANTHROPIC_API_KEY=
export SUPABASE_URL=
export SUPABASE_SERVICE_ROLE_KEY=
export MEMORY_DIR=$MEMORY_DIR
export AGENT_TOOLS=stub
EOF
  log "Wrote env template -> $ENV_FILE (fill it in)"
else
  log "Env template already exists -> $ENV_FILE (left untouched)"
fi

# 6. De-risk the SDK headless (the spec's flagged risk) -----------------------
log "Checking the Agent SDK loads headless..."
( cd "$REPO_DIR" && node -e \
  "import('@anthropic-ai/claude-agent-sdk').then(m=>console.log('  sdk ok', typeof m.query)).catch(e=>{console.error('  SDK LOAD FAILED:',e.message);process.exit(1)})" )

cat <<EOF

[setup] Done. Next:
  cd $REPO_DIR
  \$EDITOR .daytona.env        # paste your keys
  source .daytona.env
  npm run agent               # expect: [agent] online ... runs subscription: SUBSCRIBED

Then queue a run (UI "Generate" or SQL) and watch it ship.
See docs/daytona-stub-test.md for the watch + pass criteria.
EOF
