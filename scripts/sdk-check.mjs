// Confirms @anthropic-ai/claude-agent-sdk loads headless on the Daytona image —
// the spec's flagged risk. Exits non-zero (and loudly) if the SDK can't import,
// so the provisioner stops before starting the agent. Run: node scripts/sdk-check.mjs
import("@anthropic-ai/claude-agent-sdk")
  .then((m) => {
    const ok = typeof m.query === "function";
    console.log("sdk ok", typeof m.query);
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("SDK LOAD FAILED:", e.message);
    process.exit(1);
  });
