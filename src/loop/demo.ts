/**
 * Runnable demo of the self-correction loop on stubs (no infra).
 *   node --experimental-strip-types src/loop/demo.ts
 *
 * Prints the event stream the Supabase writer / Realtime UI will consume — proves
 * the loop terminates and self-corrects before any real module exists.
 */
import { runLoop } from "./controller.js";
import { makeStubDeps, SAMPLE_LIBRARY, VIRAL_RUBRIC } from "./stubs.js";

const ICON: Record<string, string> = {
  build: "•", select: "•", plan: "•", render: "▸",
  grade: "⚖", fix: "↻", ship: "✓", memory: "▸",
};

let t = 0;
const deps = makeStubDeps({
  now: () => (t += 250),
  emit: (e) => console.log(`  ${ICON[e.phase] ?? "•"} [iter ${e.iteration}] ${e.phase.toUpperCase().padEnd(7)} ${e.message}`),
});

console.log("\nAutoCut — self-correction loop (stubbed)\n");
const result = await runLoop(
  { brief: "30s Viral Short — open on the wipeout, build to sunset", rubric: VIRAL_RUBRIC, library: SAMPLE_LIBRARY },
  deps,
  { maxIters: 4, passThreshold: 7, wallclockMs: 60_000, tokenBudget: 500_000 },
);

console.log(
  `\n→ ${result.passed ? "PASSED" : "STOPPED"} (${result.stopReason}) after ${result.iterations} iteration(s); ` +
    `shipping ${result.shipped?.render.output ?? "nothing"}\n`,
);
