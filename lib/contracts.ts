/**
 * Re-export the engine contracts the UI needs, so app code imports from one
 * stable place (`@/lib/contracts`) rather than reaching into `@engine/loop/*`.
 * `types.ts` has no internal `.js` imports, so this is bundler-safe.
 */
export type { LoopEvent, Grade, LoopPhase } from "@engine/loop/types";
export { RUBRIC_DIMENSIONS } from "@engine/loop/types";
