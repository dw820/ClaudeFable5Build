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
