/**
 * Guards the shared fixtures so all five lanes build against valid, in-spec data.
 * If a lane's assumptions drift from the fixtures, this fails fast.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { ClipLibrarySchema, EdlSchema } from "../loop/types.js";
import { withinTargetLen } from "../constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string): unknown => JSON.parse(readFileSync(join(here, f), "utf8"));

describe("shared fixtures", () => {
  it("sample-clips.json is a valid ClipLibrary", () => {
    expect(() => ClipLibrarySchema.parse(load("sample-clips.json"))).not.toThrow();
  });

  it("sample-edl.json is a valid Edl", () => {
    expect(() => EdlSchema.parse(load("sample-edl.json"))).not.toThrow();
  });

  it("every EDL segment references a clip in the library", () => {
    const edl = EdlSchema.parse(load("sample-edl.json"));
    const lib = ClipLibrarySchema.parse(load("sample-clips.json"));
    const ids = new Set(lib.clips.map((c) => c.id));
    for (const seg of edl.segments) expect(ids.has(seg.clipId)).toBe(true);
  });

  it("sample EDL duration is within target tolerance", () => {
    const edl = EdlSchema.parse(load("sample-edl.json"));
    expect(withinTargetLen(edl)).toBe(true);
  });
});
