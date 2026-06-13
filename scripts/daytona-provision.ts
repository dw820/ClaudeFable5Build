/**
 * daytona-provision.ts — one-command Daytona setup for the stub-tools test.
 *
 * Run from the repo root on your laptop:
 *   tsx scripts/daytona-provision.ts
 *
 * It reads your local `.env`, then programmatically:
 *   1. gets/creates the `autocut-memory` persistent volume
 *   2. creates a sandbox with all secrets baked into envVars (no in-sandbox
 *      `.env` editing — the worker reads process.env and the vars are already there)
 *   3. clones this branch, `npm install`s, runs the SDK headless de-risk check
 *   4. starts `npm run agent` in a session and streams its logs to your terminal
 *
 * Ctrl-C detaches the log stream; the sandbox keeps running (auto-stops when idle).
 *
 * Required env (from .env or your shell):
 *   DAYTONA_API_KEY, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   GITHUB_TOKEN          — for cloning a private repo
 *   REPO_BRANCH           — default feat/autonomous-agent-daytona
 *   DAYTONA_SNAPSHOT      — override the sandbox image/snapshot
 *   DAYTONA_SANDBOX_NAME  — default autocut
 *   AGENT_TOOLS           — default stub
 */
import "dotenv/config";
import process from "node:process";
import { Daytona } from "@daytonaio/sdk";

const REQUIRED = [
  "DAYTONA_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `Missing required env: ${missing.join(", ")}\n` +
      `Set them in .env (run from repo root) or export them in your shell.`,
  );
  process.exit(1);
}

const REPO_BRANCH = process.env.REPO_BRANCH ?? "main";
const REPO_HOST = "github.com/dw820/ClaudeFable5Build.git";
const REPO_URL = process.env.GITHUB_TOKEN
  ? `https://${process.env.GITHUB_TOKEN}@${REPO_HOST}`
  : `https://${REPO_HOST}`;
const SANDBOX_NAME = process.env.DAYTONA_SANDBOX_NAME ?? "autocut";
const VOLUME_NAME = "autocut-memory";
const MEMORY_MOUNT = "/workspace/memory";
const MEDIA_MOUNT = "/home/daytona/media";
const REAL_TOOLS = (process.env.AGENT_TOOLS ?? "stub") === "real";
const REPO_DIR = "~/autocut";

// Source nvm so the default image's nvm-installed Node is on PATH in the
// non-interactive shells executeCommand uses. Harmless if Node is already global.
const NVM = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh";';

const daytona = new Daytona();

async function main() {
  console.log(`▶ volume: get/create ${VOLUME_NAME}`);
  let volume = await daytona.volume.get(VOLUME_NAME, true);

  // A freshly created volume is pending_create/creating; the sandbox create
  // rejects until it's ready. Poll until ready (or surface a terminal state).
  const deadline = Date.now() + 120_000;
  while (volume.state !== "ready") {
    if (volume.state === "error" || volume.state === "deleted") {
      throw new Error(`volume ${VOLUME_NAME} entered terminal state: ${volume.state}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`volume ${VOLUME_NAME} not ready after 120s (state: ${volume.state})`);
    }
    console.log(`  waiting for volume… (${volume.state})`);
    await new Promise((r) => setTimeout(r, 3000));
    volume = await daytona.volume.get(VOLUME_NAME);
  }
  console.log(`  volume ready: ${volume.id}`);

  // Idempotency: tear down a prior sandbox of the same name so re-runs don't pile up.
  try {
    const existing = await daytona.get(SANDBOX_NAME);
    console.log(`▶ sandbox: deleting existing "${SANDBOX_NAME}" (${existing.id})`);
    await existing.delete();
  } catch {
    /* none with that name — fine */
  }

  console.log(`▶ sandbox: creating "${SANDBOX_NAME}" (env baked in)`);
  const sandbox = await daytona.create(
    {
      name: SANDBOX_NAME,
      ...(process.env.DAYTONA_SNAPSHOT
        ? { snapshot: process.env.DAYTONA_SNAPSHOT }
        : { language: "typescript" }),
      envVars: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
        SUPABASE_URL: process.env.SUPABASE_URL!,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        MEMORY_DIR: MEMORY_MOUNT,
        MEDIA_DIR: MEDIA_MOUNT,
        AGENT_TOOLS: process.env.AGENT_TOOLS ?? "stub",
      },
      volumes: [{ volumeId: volume.id, mountPath: MEMORY_MOUNT }],
      autoStopInterval: 60, // minutes idle → auto-stop (cost control)
    },
    { timeout: 180 },
  );
  console.log(`  sandbox id: ${sandbox.id}`);
  // Note: the sandbox has a 1 GiB cgroup limit but sees 48 host CPUs. ffmpeg is
  // thread-capped (FFMPEG_THREADS, default 4) so x264 doesn't OOM the cgroup —
  // see src/edit/ffmpegArgs.ts. No sandbox resize needed (and it's unsupported here).

  const proc = sandbox.process;

  // Run a command in a login shell with nvm sourced; throw loudly on non-zero exit.
  const run = async (label: string, cmd: string, timeout = 600) => {
    console.log(`\n▶ ${label}`);
    const res = await proc.executeCommand(
      `bash -lc '${NVM} ${cmd}'`,
      undefined,
      undefined,
      timeout,
    );
    const out = res.result?.trim();
    if (out) console.log(out);
    if (res.exitCode !== 0) {
      throw new Error(`"${label}" failed (exit ${res.exitCode}). See output above.`);
    }
    return res;
  };

  // Clone with the token in the URL, then scrub it from the remote so it isn't
  // left in the sandbox's git config.
  await run(
    "git clone",
    `rm -rf ${REPO_DIR} && git clone -b ${REPO_BRANCH} ${REPO_URL} ${REPO_DIR} && ` +
      `git -C ${REPO_DIR} remote set-url origin https://${REPO_HOST}`,
  );
  await run("npm install", `cd ${REPO_DIR} && npm install`, 900);
  if (REAL_TOOLS) {
    await run(
      "install ffmpeg + font",
      "sudo apt-get update && sudo apt-get install -y ffmpeg fonts-dejavu-core",
      900,
    );
    await run(
      "fetch source clips",
      `cd ${REPO_DIR} && MEDIA_DIR=${MEDIA_MOUNT} node scripts/fetch-clips.mjs`,
    );
  }
  await run("ensure memory dir", `mkdir -p ${MEMORY_MOUNT}`);
  await run("SDK de-risk check", `cd ${REPO_DIR} && node scripts/sdk-check.mjs`);

  // Long-lived worker: a session command (runAsync) whose logs we stream.
  console.log(`\n▶ starting agent (npm run agent) in session — streaming logs`);
  console.log(`  Ctrl-C detaches; the sandbox keeps running.\n`);
  const sessionId = "agent";
  await proc.createSession(sessionId);
  const started = await proc.executeSessionCommand(sessionId, {
    command: `bash -lc '${NVM} cd ${REPO_DIR} && npm run agent'`,
    runAsync: true,
  });
  await proc.getSessionCommandLogs(
    sessionId,
    started.cmdId!,
    (chunk: string) => process.stdout.write(chunk),
    (chunk: string) => process.stderr.write(chunk),
  );

  console.log(
    `\n[provision] log stream ended. Manage the sandbox with the Daytona CLI:\n` +
      `  daytona ssh ${SANDBOX_NAME}        # shell in\n` +
      `  daytona stop ${SANDBOX_NAME}       # stop (volume + state persist)\n` +
      `  daytona delete ${SANDBOX_NAME}     # tear down`,
  );
}

main().catch((err) => {
  console.error(`\n[provision] FAILED: ${err.message}`);
  process.exit(1);
});
