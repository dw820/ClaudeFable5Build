/**
 * Unit tests (offline, no binaries):
 *  - captionProps maps sample-edl.json to correct ABSOLUTE timings.
 *  - ffmpegCaptions builds drawtext filters with enable='between(t,t0,t1)'.
 *  - injecting a Remotion renderer that throws flips usedFallback=true and
 *    still returns a path (via the injected ffmpeg exec).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EdlSchema, type Edl } from "../loop/types.js";
import { edlToCaptionProps } from "./captionProps.js";
import {
  buildDrawtextFiltergraph,
  buildFfmpegCaptionArgs,
  drawtextFilter,
  escapeDrawtext,
} from "./ffmpegCaptions.js";
import { applyOverlay } from "./overlay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleEdl: Edl = EdlSchema.parse(
  JSON.parse(readFileSync(path.join(here, "../__fixtures__/sample-edl.json"), "utf8")),
);

describe("edlToCaptionProps", () => {
  const props = edlToCaptionProps("/tmp/cut.mp4", sampleEdl);

  it("passes through base path and aspect", () => {
    expect(props.basePath).toBe("/tmp/cut.mp4");
    expect(props.aspect).toBe("9:16");
  });

  it("emits one absolute caption per source caption, in order", () => {
    expect(props.captions.map((c) => c.text)).toEqual([
      "watch this",
      "everyone runs",
      "paddle out",
      "stay till sunset",
      "watch this",
    ]);
  });

  it("promotes per-segment timings to absolute, honoring crossfade overlap", () => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const windows = props.captions.map((c) => [round(c.startS), round(c.endS)]);
    expect(windows).toEqual([
      [0, 1.5], // seg0 start 0
      [3.5, 5.5], // seg1 start 3.5
      [10.8, 12.6], // seg3 start 10.6 (after a crossfade seg) + t0 0.2
      [22.3, 24.8], // seg5 crossfade start 22.3
      [27.3, 28.8], // seg6 start 27.3
    ]);
  });

  it("computes total duration matching the EDL timeline (29.8s)", () => {
    expect(Math.round(props.durationS * 100) / 100).toBe(29.8);
  });
});

describe("ffmpegCaptions drawtext", () => {
  it("gates each caption with enable='between(t,t0,t1)'", () => {
    const f = drawtextFilter("hi", 1.0, 2.5, "bold-center");
    expect(f).toContain("drawtext=");
    expect(f).toContain("text='hi'");
    expect(f).toContain("enable='between(t,1,2.5)'");
    expect(f).toContain("fontsize=");
    expect(f).toContain("box=1");
  });

  it("escapes special chars for the filtergraph parser", () => {
    // ' → curly apostrophe (safe inside text='...'); : and % stay literal via \.
    expect(escapeDrawtext("50% it's 3:30")).toBe("50\\% it’s 3\\:30");
  });

  it("neutralizes filtergraph-structural chars that quotes don't protect", () => {
    // The real bug: a comma split the filtergraph → `No such filter: '2'`.
    expect(escapeDrawtext("3, 2, 1")).toBe("3 2 1");
    expect(escapeDrawtext("wait [for] it; go")).toBe("wait for it go");
    // Structural chars must not survive into the output at all.
    expect(escapeDrawtext("a,b;c[d]e=f")).not.toMatch(/[,;[\]=]/);
  });

  it("chains one drawtext per caption for the sample EDL", () => {
    const graph = buildDrawtextFiltergraph(sampleEdl);
    const count = graph.split("drawtext=").length - 1;
    expect(count).toBe(5);
    expect(graph).toContain("enable='between(t,3.5,5.5)'");
  });

  it("builds full argv with -vf and input/output", () => {
    const args = buildFfmpegCaptionArgs("/in.mp4", "/out.mp4", sampleEdl);
    expect(args[0]).toBe("-y");
    expect(args).toContain("-i");
    expect(args).toContain("/in.mp4");
    expect(args).toContain("-vf");
    expect(args[args.length - 1]).toBe("/out.mp4");
  });

  it("copies through when there are no captions", () => {
    const empty: Edl = { ...sampleEdl, segments: [{ ...sampleEdl.segments[0]!, captions: [] }] };
    const args = buildFfmpegCaptionArgs("/in.mp4", "/out.mp4", empty);
    expect(args).toContain("copy");
    expect(args).not.toContain("-vf");
  });
});

describe("applyOverlay fallback", () => {
  it("uses Remotion on success (usedFallback=false), no ffmpeg call", async () => {
    const renderRemotion = vi.fn().mockResolvedValue(undefined);
    const runFfmpeg = vi.fn().mockResolvedValue(undefined);

    const res = await applyOverlay("/tmp/cut.mp4", sampleEdl, { renderRemotion, runFfmpeg });

    expect(res.usedFallback).toBe(false);
    expect(res.path).toBe("/tmp/cut.captioned.mp4");
    expect(renderRemotion).toHaveBeenCalledOnce();
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("flips usedFallback=true and still returns a path when Remotion throws", async () => {
    const renderRemotion = vi.fn().mockRejectedValue(new Error("boom"));
    const runFfmpeg = vi.fn().mockResolvedValue(undefined);

    const res = await applyOverlay("/tmp/cut.mp4", sampleEdl, { renderRemotion, runFfmpeg });

    expect(res.usedFallback).toBe(true);
    expect(res.path).toBe("/tmp/cut.ff.mp4");
    expect(runFfmpeg).toHaveBeenCalledOnce();
    // the ffmpeg argv carries the drawtext filtergraph
    const args = runFfmpeg.mock.calls[0]![0] as string[];
    expect(args).toContain("-vf");
    expect(args.some((a) => a.includes("drawtext="))).toBe(true);
  });

  it("falls back on Remotion timeout", async () => {
    const renderRemotion = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    );
    const runFfmpeg = vi.fn().mockResolvedValue(undefined);

    const res = await applyOverlay("/tmp/cut.mp4", sampleEdl, {
      renderRemotion,
      runFfmpeg,
      timeoutMs: 20,
    });

    expect(res.usedFallback).toBe(true);
    expect(runFfmpeg).toHaveBeenCalledOnce();
  });
});
