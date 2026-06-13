/**
 * Memory module — the agent's outer loop (consult before a run, distill after a
 * pass). File-based on the agent's persistent disk; dir is injected.
 */
export { consult, styleDir, DEFAULT_MEMORY_DIR, type Rule } from "./consult.js";
export { distill, deriveRule, type DistillRun } from "./distill.js";
