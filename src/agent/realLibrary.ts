/**
 * Load the fixture clip library from a JSON file (Phase 3 real mode). The video
 * files it names live in MEDIA_DIR; this only reads + schema-validates metadata.
 */
import { readFile } from "node:fs/promises";
import { ClipLibrarySchema, type ClipLibrary } from "../loop/types.js";

export const DEFAULT_CLIPS_JSON = "fixtures/clips.json";

export async function loadClipLibrary(
  path: string = process.env.CLIPS_JSON ?? DEFAULT_CLIPS_JSON,
): Promise<ClipLibrary> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`Could not read clip library at "${path}": ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Clip library at "${path}" is not valid JSON: ${(e as Error).message}`);
  }
  return ClipLibrarySchema.parse(json);
}
