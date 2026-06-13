/**
 * smoke-real-tools.ts — exercise the real tools locally against fixtures/clips.json.
 * Runs build_edl (LLM) → render (ffmpeg) → grade (vision) once and prints results.
 *
 * Prereqs: ffmpeg/ffprobe on PATH; MEDIA_DIR populated (npm run fixture:fetch or
 * local copies); ANTHROPIC_API_KEY + SUPABASE_* in .env. Run: npm run smoke:real
 */
import "dotenv/config";
import process from "node:process";
import { AnthropicClient } from "../src/llm/client.js";
import { loadClipLibrary } from "../src/agent/realLibrary.js";
import { makeRealToolImpls } from "../src/agent/realTools.js";
import { VIRAL_RUBRIC } from "../src/loop/stubs.js";
import { EdlSchema } from "../src/loop/types.js";

const lib = await loadClipLibrary();
const impls = makeRealToolImpls({
  llm: new AnthropicClient(),
  library: lib,
  brief: "Make a punchy viral short from the library.",
  rubric: VIRAL_RUBRIC,
});

const clipIds = lib.clips.map((c) => c.id);
console.log(`build_edl over ${clipIds.length} clips...`);
const raw = await impls.buildEdl(clipIds, "lead with the strongest hook", lib);
const edl = EdlSchema.parse(raw);
console.log(`  EDL ${edl.edlId}: ${edl.segments.length} segment(s), target ${edl.targetLenS}s`);

console.log("render (ffmpeg)...");
const r = await impls.render(edl);
console.log(`  render ${r.renderId} -> ${r.output} (usedFallback=${r.usedFallback})`);

console.log("grade (vision)...");
const g = await impls.grade(r, VIRAL_RUBRIC);
console.log(`  scores: ${JSON.stringify(g.scores)}`);
console.log(`\nOK — real mp4 at ${r.output}`);
