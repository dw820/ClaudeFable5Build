import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClipLibrary } from "./realLibrary.js";

const VALID = {
  projectId: "fixture",
  clips: [
    { id: "c01", src: "a.mp4", start: 0, end: 6, duration: 6, resolution: [1080, 1920], transcript: [], caption: "hook", tags: ["a"] },
  ],
};

async function withTmpFile(contents: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "clips-"));
  const path = join(dir, "clips.json");
  await writeFile(path, contents);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadClipLibrary", () => {
  it("loads and validates a well-formed clips.json", async () => {
    await withTmpFile(JSON.stringify(VALID), async (path) => {
      const lib = await loadClipLibrary(path);
      expect(lib.clips[0]!.id).toBe("c01");
      expect(lib.projectId).toBe("fixture");
    });
  });

  it("throws a clear error when the file is missing", async () => {
    await expect(loadClipLibrary("/no/such/clips.json")).rejects.toThrow(/Could not read clip library/);
  });

  it("throws when the JSON does not satisfy the schema", async () => {
    await withTmpFile(JSON.stringify({ projectId: "x", clips: [] }), async (path) => {
      await expect(loadClipLibrary(path)).rejects.toThrow();
    });
  });
});
