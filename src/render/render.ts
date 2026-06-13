/**
 * Render composition factory.
 *
 * The frozen `LoopDeps.render` is `(edl) => Promise<RenderResult>` — no library
 * argument. But cutting needs the ClipLibrary. `makeRender` closes over the
 * library and composes Lane A's `cutVideo` + Lane B's `applyOverlay` into a
 * function with exactly the dep signature the controller expects. The deps.ts
 * integration factory calls this; lanes A/B never touch it.
 *
 *   edl ──▶ cutVideo(edl, library) ──▶ applyOverlay(cutPath, edl) ──▶ RenderResult
 */
import type { ClipLibrary, Edl, RenderResult } from "../loop/types.js";

export interface RenderModules {
  cutVideo: (edl: Edl, clips: ClipLibrary) => Promise<{ path: string; durationS: number }>;
  applyOverlay: (basePath: string, edl: Edl) => Promise<{ path: string; usedFallback: boolean }>;
}

export function makeRender(
  library: ClipLibrary,
  mods: RenderModules,
): (edl: Edl) => Promise<RenderResult> {
  return async (edl: Edl): Promise<RenderResult> => {
    const cut = await mods.cutVideo(edl, library);
    const overlaid = await mods.applyOverlay(cut.path, edl);
    return {
      renderId: edl.edlId,
      output: overlaid.path,
      usedFallback: overlaid.usedFallback,
    };
  };
}
