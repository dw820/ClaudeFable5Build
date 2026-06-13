/**
 * Integration test for the EDL builder (Lane D) against the real Anthropic API.
 *
 * Gated on ANTHROPIC_API_KEY so the unit suite runs offline. With the real
 * AnthropicClient on claude-opus-4-8, the sample clips + viral-short rubric must
 * produce an object that passes EdlSchema and references only real clip ids.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnthropicClient } from "../llm/client.js";
import type { BuildContext, Rubric } from "../loop/controller.js";
import { ClipLibrarySchema, EdlSchema, type ClipLibrary } from "../loop/types.js";
import { makeBuildEdl } from "./build.js";

const hasKey = !!process.env.ANTHROPIC_API_KEY;

const library: ClipLibrary = ClipLibrarySchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../__fixtures__/sample-clips.json", import.meta.url)),
      "utf8",
    ),
  ),
);

const rubric: Rubric = { style: "Viral Short", passThreshold: 7 };

describe("makeBuildEdl (integration)", () => {
  it.skipIf(!hasKey)(
    "produces a schema-valid EDL referencing real clip ids",
    async () => {
      const buildEdl = makeBuildEdl(new AnthropicClient());
      const ctx: BuildContext = {
        brief: "A high-energy beach surf trip montage for a vertical short",
        rubric,
        library,
        iteration: 1,
      };

      const result = await buildEdl(ctx);
      const parsed = EdlSchema.safeParse(result);
      expect(parsed.success).toBe(true);

      if (parsed.success) {
        const ids = new Set(library.clips.map((c) => c.id));
        for (const seg of parsed.data.segments) {
          expect(ids.has(seg.clipId)).toBe(true);
        }
      }
    },
    60_000,
  );
});
