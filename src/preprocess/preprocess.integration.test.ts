/**
 * Integration suite for preprocess. Hits real Replicate (whisper + VLM) and
 * real ffmpeg/ffprobe on one generated sample.mp4, asserting the emitted
 * clips.json validates ClipLibrarySchema. Skipped unless REPLICATE_API_TOKEN
 * is set. The pgvector test is additionally skipped unless SUPABASE_URL is set.
 *
 * Prereq: generate the fixture first — `bash src/__fixtures__/generate.sh`.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClipLibrarySchema } from "../loop/types.js";
import { makeReplicateRunner } from "./replicateClient.js";
import { ffmpegFrameSampler, type ExecFn } from "./frameUnderstand.js";
import { preprocessClip } from "./cli.js";
import { assembleLibrary, type ClipMeta } from "./assemble.js";
import {
  upsertEmbeddings,
  type SupabaseLike,
} from "./pgvector.js";
import {
  makeStorageClient,
  uploadLibraryAssets,
  SOURCE_CLIPS_BUCKET,
} from "./storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, "..", "__fixtures__", "sample.mp4");

const hasReplicate = !!process.env.REPLICATE_API_TOKEN;
const hasSupabase =
  !!process.env.SUPABASE_URL &&
  (!!process.env.SUPABASE_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY);

/** Binary-safe exec for the integration run (mirrors cli.ts). */
const execBinary: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.on("error", reject);
    child.on("close", () =>
      resolve({ stdout: Buffer.concat(out).toString("binary"), stderr: "" }),
    );
  });

async function probeClip(path: string): Promise<ClipMeta> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      path,
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const json = JSON.parse(out) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const s = json.streams?.[0] ?? {};
  return {
    durationS: Number(json.format?.duration ?? 0),
    width: Number(s.width ?? 0),
    height: Number(s.height ?? 0),
  };
}

describe("preprocess integration", () => {
  it.skipIf(!hasReplicate)(
    "produces a clips.json that validates ClipLibrarySchema",
    async () => {
      if (!existsSync(SAMPLE)) {
        throw new Error(
          `${SAMPLE} missing — run: bash src/__fixtures__/generate.sh`,
        );
      }
      const runner = makeReplicateRunner();
      const sampler = ffmpegFrameSampler(execBinary);
      const mediaDir = join(here, "..", "__fixtures__");

      const parts = await preprocessClip(
        runner,
        sampler,
        probeClip,
        mediaDir,
        SAMPLE,
      );
      const library = assembleLibrary("integration", [parts]);

      expect(() => ClipLibrarySchema.parse(library)).not.toThrow();
      expect(library.clips[0]!.duration).toBeGreaterThan(0);
      expect(library.clips[0]!.resolution[0]).toBeGreaterThan(0);

      // Round-trip through clips.json on disk.
      const dir = await mkdtemp(join(tmpdir(), "preprocess-"));
      try {
        const out = join(dir, "clips.json");
        const { writeClipsJson } = await import("./assemble.js");
        await writeClipsJson(library, out);
        const { readFileSync } = await import("node:fs");
        const parsed = JSON.parse(readFileSync(out, "utf8"));
        expect(() => ClipLibrarySchema.parse(parsed)).not.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(!hasReplicate || !hasSupabase)(
    "upserts an embedding to a real Supabase pgvector table",
    async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_KEY!,
      ) as unknown as SupabaseLike;
      const { embedText } = await import("./embed.js");
      const runner = makeReplicateRunner();
      const embedding = await embedText(runner, { text: "integration caption" });
      await expect(
        upsertEmbeddings(client, [
          {
            clipId: "integration-clip",
            projectId: "integration",
            caption: "integration caption",
            embedding,
          },
        ]),
      ).resolves.not.toThrow();
    },
    120_000,
  );

  it.skipIf(!hasSupabase)(
    "uploads clips + manifest to the real source-clips bucket",
    async () => {
      const client = makeStorageClient();
      if (!client) throw new Error("expected a Storage client when SUPABASE_* set");
      const lib = assembleLibrary("itest", [
        {
          id: "c01",
          src: "c01.mov",
          meta: { durationS: 3, width: 1080, height: 1920 },
          transcript: [],
          caption: "x",
          tags: [],
        },
      ]);
      const out = await uploadLibraryAssets(
        client,
        SOURCE_CLIPS_BUCKET,
        "itest",
        lib,
        async () => new Uint8Array([0, 1, 2, 3]),
      );
      expect(out.clips[0]!.src).toBe("storage://itest/c01.mov");
    },
    120_000,
  );
});
