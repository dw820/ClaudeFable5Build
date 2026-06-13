/**
 * Unit suite for the offline preprocess pipeline. No network, no ffmpeg:
 * the Replicate runner and Supabase client are mocked; the frame sampler is a
 * fake. Covers request construction, pure response→Clip mapping, schema
 * validation in assemble, the empty-transcript shadow path, and the pgvector
 * upsert call shape.
 */
import { describe, it, expect } from "vitest";
import { ClipLibrarySchema } from "../loop/types.js";
import { FakeReplicateRunner } from "./replicateClient.js";
import {
  parseWhisperWords,
  whisperInput,
  transcribeClip,
} from "./transcribe.js";
import {
  parseVlmResponse,
  vlmInput,
  VLM_PROMPT,
  understandFrames,
  type FrameSampler,
} from "./frameUnderstand.js";
import { parseEmbedding, embedInput, embedText } from "./embed.js";
import {
  buildClip,
  assembleLibrary,
  type ClipParts,
} from "./assemble.js";
import {
  upsertEmbeddings,
  embeddingRow,
  type SupabaseLike,
  type PgvectorTable,
  type UpsertResult,
} from "./pgvector.js";
import {
  SOURCE_CLIPS_BUCKET,
  clipStorageRef,
  clipStorageKey,
  libraryKey,
  contentTypeFor,
  uploadClip,
  uploadLibrary,
  uploadLibraryAssets,
  type StorageClientLike,
} from "./storage.js";
import { WHISPER_MODEL } from "./models.js";

/* ----------------------------- transcribe ------------------------------ */

describe("transcribe", () => {
  it("parses HF chunks shape into word timestamps", () => {
    const words = parseWhisperWords({
      chunks: [
        { text: "watch", timestamp: [0.2, 0.5] },
        { text: "this", timestamp: [0.5, 0.8] },
      ],
    });
    expect(words).toEqual([
      { word: "watch", t0: 0.2, t1: 0.5 },
      { word: "this", t0: 0.5, t1: 0.8 },
    ]);
  });

  it("parses segments[].words shape", () => {
    const words = parseWhisperWords({
      segments: [{ words: [{ word: "go", start: 1.0, end: 1.3 }] }],
    });
    expect(words).toEqual([{ word: "go", t0: 1.0, t1: 1.3 }]);
  });

  it("interpolates words from segment-level output (no per-word array)", () => {
    // Base openai/whisper returns segments with text + a span but no words[].
    const words = parseWhisperWords({
      segments: [{ start: 0, end: 2, text: "hello there" }],
    });
    expect(words).toEqual([
      { word: "hello", t0: 0, t1: 1 },
      { word: "there", t0: 1, t1: 2 },
    ]);
  });

  it("prefers nested words[] over the segment-span fallback", () => {
    const words = parseWhisperWords({
      segments: [
        { start: 0, end: 2, text: "hi yo", words: [{ word: "hi", start: 0.1, end: 0.4 }] },
      ],
    });
    expect(words).toEqual([{ word: "hi", t0: 0.1, t1: 0.4 }]);
  });

  it("parses flat words[] shape and clamps t1<t0", () => {
    const words = parseWhisperWords({
      words: [{ word: "x", start: 2, end: 1 }],
    });
    expect(words).toEqual([{ word: "x", t0: 2, t1: 2 }]);
  });

  it("returns [] for silent / unknown responses (empty shadow path)", () => {
    expect(parseWhisperWords({})).toEqual([]);
    expect(parseWhisperWords(null)).toEqual([]);
    expect(parseWhisperWords({ chunks: [] })).toEqual([]);
  });

  it("builds a word-timestamp request and maps the response", async () => {
    const runner = new FakeReplicateRunner([
      { chunks: [{ text: "hi", timestamp: [0, 0.3] }] },
    ]);
    const out = await transcribeClip(runner, { audio: "media/a.mp4" });
    expect(out).toEqual([{ word: "hi", t0: 0, t1: 0.3 }]);

    const call = runner.seenCalls[0]!;
    expect(call.identifier).toBe(WHISPER_MODEL);
    expect(call.input).toEqual(whisperInput("media/a.mp4"));
    expect(call.input).toMatchObject({ audio: "media/a.mp4", timestamp: "word" });
  });

  it("degrades a no-audio clip to an empty transcript (does not throw)", async () => {
    const runner = new FakeReplicateRunner(() => {
      throw new Error(
        "Prediction failed: Failed to load audio: ... Output file #0 does not contain any stream",
      );
    });
    await expect(transcribeClip(runner, { audio: "silent.mp4" })).resolves.toEqual([]);
  });

  it("rethrows non-audio failures (auth, rate-limit, real model errors)", async () => {
    const runner = new FakeReplicateRunner(() => {
      throw new Error("401 Unauthorized");
    });
    await expect(transcribeClip(runner, { audio: "x.mp4" })).rejects.toThrow(/401/);
  });
});

/* --------------------------- frameUnderstand --------------------------- */

const fakeSampler = (frames: string[]): FrameSampler => ({
  async sample() {
    return frames;
  },
});

describe("frameUnderstand", () => {
  it("parses strict JSON caption + tags and normalizes tags", () => {
    const out = parseVlmResponse(
      '```json\n{"caption":"a surfer wipes out","tags":["Action","action","Ocean"]}\n```',
    );
    expect(out.caption).toBe("a surfer wipes out");
    expect(out.tags).toEqual(["action", "ocean"]);
  });

  it("joins streamed token arrays before parsing", () => {
    const out = parseVlmResponse(["{\"caption\":\"x\",", '"tags":["y"]}']);
    expect(out).toEqual({ caption: "x", tags: ["y"] });
  });

  it("falls back to prose-as-caption when no JSON present", () => {
    const out = parseVlmResponse("just  a   sentence");
    expect(out).toEqual({ caption: "just a sentence", tags: [] });
  });

  it("builds a VLM request with the frame ref + prompt", async () => {
    const runner = new FakeReplicateRunner([
      '{"caption":"c","tags":["t"]}',
    ]);
    const sampler = fakeSampler(["data:image/jpeg;base64,AAAA"]);
    const out = await understandFrames(runner, sampler, { clipPath: "x.mp4" });
    expect(out).toEqual({ caption: "c", tags: ["t"] });

    const call = runner.seenCalls[0]!;
    expect(call.input).toEqual(vlmInput("data:image/jpeg;base64,AAAA"));
    expect(call.input).toMatchObject({ prompt: VLM_PROMPT });
  });

  it("returns empty understanding when no frames were sampled", async () => {
    const runner = new FakeReplicateRunner([]);
    const out = await understandFrames(runner, fakeSampler([]), {
      clipPath: "x.mp4",
    });
    expect(out).toEqual({ caption: "", tags: [] });
    expect(runner.seenCalls).toHaveLength(0); // no VLM call when no frames
  });
});

/* -------------------------------- embed -------------------------------- */

describe("embed", () => {
  it("parses a bare vector", () => {
    expect(parseEmbedding([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });
  it("parses [{ embedding }] and { embedding } shapes", () => {
    expect(parseEmbedding([{ embedding: [1, 2] }])).toEqual([1, 2]);
    expect(parseEmbedding({ embedding: [3, 4] })).toEqual([3, 4]);
    expect(parseEmbedding({ vectors: [[5, 6]] })).toEqual([5, 6]);
  });
  it("returns [] for unknown shapes", () => {
    expect(parseEmbedding({ nope: true })).toEqual([]);
  });
  it("builds an embed request and maps the response", async () => {
    const runner = new FakeReplicateRunner([[0.5, 0.6]]);
    const vec = await embedText(runner, { text: "a caption" });
    expect(vec).toEqual([0.5, 0.6]);
    expect(runner.seenCalls[0]!.input).toEqual(embedInput("a caption"));
  });
});

/* ------------------------------ assemble ------------------------------- */

const partFixture = (over: Partial<ClipParts> = {}): ClipParts => ({
  id: "c01",
  src: "clips/wipeout.mp4",
  meta: { durationS: 12, width: 1080, height: 1920 },
  transcript: [{ word: "watch", t0: 0.2, t1: 0.5 }],
  caption: "a surfer wipes out",
  tags: ["action", "ocean"],
  ...over,
});

describe("assemble", () => {
  it("builds a Clip with start=0, end=duration from parts", () => {
    const clip = buildClip(partFixture());
    expect(clip).toMatchObject({
      id: "c01",
      src: "clips/wipeout.mp4",
      start: 0,
      end: 12,
      duration: 12,
      resolution: [1080, 1920],
    });
  });

  it("throws on a non-positive (probe-failure) duration", () => {
    expect(() => buildClip(partFixture({ meta: { durationS: 0, width: 1, height: 1 } }))).toThrow(
      /non-positive duration/,
    );
  });

  it("assembles a library that validates ClipLibrarySchema", () => {
    const lib = assembleLibrary("beach-trip", [
      partFixture(),
      partFixture({ id: "c02", src: "clips/sunset.mp4" }),
    ]);
    expect(() => ClipLibrarySchema.parse(lib)).not.toThrow();
    expect(lib.projectId).toBe("beach-trip");
    expect(lib.clips).toHaveLength(2);
  });

  it("handles a clip with an EMPTY transcript (shadow path)", () => {
    const lib = assembleLibrary("p", [
      partFixture({ id: "silent", transcript: [], caption: "b-roll", tags: [] }),
    ]);
    expect(() => ClipLibrarySchema.parse(lib)).not.toThrow();
    expect(lib.clips[0]!.transcript).toEqual([]);
  });
});

/* ------------------------------ pgvector ------------------------------- */

describe("pgvector", () => {
  it("maps a ClipEmbedding to the table row shape", () => {
    expect(
      embeddingRow({ clipId: "c01", projectId: "p", embedding: [1, 2], caption: "x" }),
    ).toEqual({ clip_id: "c01", project_id: "p", caption: "x", embedding: [1, 2] });
  });

  it("upserts rows on the mocked client keyed by clip_id", async () => {
    const calls: { table: string; rows: object[]; onConflict?: string }[] = [];
    const result: UpsertResult = { error: null };
    const table: PgvectorTable = {
      async upsert(rows, options) {
        calls.push({ table: "clip_embeddings", rows, onConflict: options?.onConflict });
        return result;
      },
    };
    const client: SupabaseLike = { from: () => table };

    await upsertEmbeddings(client, [
      { clipId: "c01", projectId: "p", embedding: [0.1], caption: "x" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.onConflict).toBe("clip_id");
    expect(calls[0]!.rows[0]).toMatchObject({ clip_id: "c01", embedding: [0.1] });
  });

  it("throws when the client reports an error", async () => {
    const client: SupabaseLike = {
      from: () => ({
        async upsert() {
          return { error: { message: "boom" } };
        },
      }),
    };
    await expect(
      upsertEmbeddings(client, [
        { clipId: "c", projectId: "p", embedding: [1], caption: "x" },
      ]),
    ).rejects.toThrow(/pgvector upsert failed: boom/);
  });

  it("is a no-op for an empty embedding list", async () => {
    let called = false;
    const client: SupabaseLike = {
      from: () => ({
        async upsert() {
          called = true;
          return { error: null };
        },
      }),
    };
    await upsertEmbeddings(client, []);
    expect(called).toBe(false);
  });
});

/* ------------------------------ storage -------------------------------- */

interface RecordedUpload {
  bucket: string;
  path: string;
  contentType?: string;
  upsert?: boolean;
}

/** Fake Storage client that records every upload call. */
function fakeStorage(error: { message: string } | null = null): {
  client: StorageClientLike;
  uploads: RecordedUpload[];
} {
  const uploads: RecordedUpload[] = [];
  const client: StorageClientLike = {
    from: (bucket) => ({
      async upload(path, _body, options) {
        uploads.push({ bucket, path, contentType: options?.contentType, upsert: options?.upsert });
        return { error };
      },
    }),
  };
  return { client, uploads };
}

describe("storage helpers", () => {
  it("builds storage refs and keys", () => {
    expect(clipStorageRef("proj", "a.mov")).toBe("storage://proj/a.mov");
    expect(clipStorageKey("proj", "a.mov")).toBe("proj/a.mov");
    expect(libraryKey("proj")).toBe("proj/clips.json");
  });

  it("maps content types case-insensitively", () => {
    expect(contentTypeFor("clip.mp4")).toBe("video/mp4");
    expect(contentTypeFor("CLIP.MOV")).toBe("video/quicktime");
    expect(contentTypeFor("clip.webm")).toBe("video/webm");
    expect(contentTypeFor("clip.unknown")).toBe("application/octet-stream");
  });

  it("names the source-clips bucket", () => {
    expect(SOURCE_CLIPS_BUCKET).toBe("source-clips");
  });
});

describe("storage upload", () => {
  it("uploads a clip to <project>/<src> with content type and upsert", async () => {
    const { client, uploads } = fakeStorage();
    await uploadClip(client, "source-clips", "proj", "a.mov", new Uint8Array([1, 2]));
    expect(uploads).toEqual([
      { bucket: "source-clips", path: "proj/a.mov", contentType: "video/quicktime", upsert: true },
    ]);
  });

  it("throws when a clip upload reports an error", async () => {
    const { client } = fakeStorage({ message: "boom" });
    await expect(
      uploadClip(client, "source-clips", "proj", "a.mov", new Uint8Array([1])),
    ).rejects.toThrow(/source-clip upload failed \(a\.mov\): boom/);
  });

  it("uploads the manifest as JSON with upsert", async () => {
    const { client, uploads } = fakeStorage();
    const lib = assembleLibrary("proj", [partFixture({ id: "c01", src: "a.mov" })]);
    await uploadLibrary(client, "source-clips", "proj", lib);
    expect(uploads).toEqual([
      {
        bucket: "source-clips",
        path: "proj/clips.json",
        contentType: "application/json",
        upsert: true,
      },
    ]);
  });
});

describe("uploadLibraryAssets", () => {
  it("uploads clips then the manifest, rewriting src without mutating the input", async () => {
    const { client, uploads } = fakeStorage();
    const lib = assembleLibrary("proj", [
      partFixture({ id: "c01", src: "a.mov" }),
      partFixture({ id: "c02", src: "b.mp4" }),
    ]);
    const readClip = async (src: string) => new Uint8Array([src.length]);

    const uploaded = await uploadLibraryAssets(client, "source-clips", "proj", lib, readClip);

    expect(uploads.map((u) => u.path)).toEqual(["proj/a.mov", "proj/b.mp4", "proj/clips.json"]);
    expect(uploaded.clips.map((c) => c.src)).toEqual([
      "storage://proj/a.mov",
      "storage://proj/b.mp4",
    ]);
    expect(lib.clips[0]!.src).toBe("a.mov");
  });
});
