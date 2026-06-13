import { describe, it, expect } from "vitest";
import { eventsToState } from "./eventsToState";
import type { LoopEvent, Grade } from "@/lib/contracts";

const failScores: Grade["scores"] = {
  hook_strength: 5,
  pace_cut_density: 8,
  caption_legibility: 6,
  loopability: 7,
  on_style_trend_fit: 8,
};

const passScores: Grade["scores"] = {
  hook_strength: 8,
  pace_cut_density: 9,
  caption_legibility: 8,
  loopability: 8,
  on_style_trend_fit: 9,
};

/** A full run: build→render→grade(fail 3/5)→fix→build→grade(pass 5/5)→ship. */
function run(): LoopEvent[] {
  let ts = 1_000;
  const at = () => (ts += 10);
  return [
    { iteration: 1, phase: "build", message: "EDL v1", ts: at() },
    { iteration: 1, phase: "render", message: "ffmpeg cut", ts: at() },
    {
      iteration: 1,
      phase: "grade",
      message: "Director: 3/5 FAIL",
      scores: failScores,
      ts: at(),
    },
    { iteration: 1, phase: "fix", message: "hook weak", ts: at() },
    { iteration: 2, phase: "build", message: "EDL v2", ts: at() },
    {
      iteration: 2,
      phase: "grade",
      message: "Director: 5/5 PASS",
      scores: passScores,
      ts: at(),
    },
    { iteration: 2, phase: "ship", message: "shipped best-so-far", ts: at() },
  ];
}

describe("eventsToState", () => {
  it("folds a full pass run into shipped state", () => {
    const s = eventsToState(run());
    expect(s.iteration).toBe(2);
    expect(s.status).toBe("shipped");
    expect(s.passedCount).toBe(5);
    expect(s.verdict).toBe("pass");
    expect(s.currentScores).toEqual(passScores);
  });

  it("preserves event order in steps", () => {
    const s = eventsToState(run());
    expect(s.steps.map((e) => e.phase)).toEqual([
      "build",
      "render",
      "grade",
      "fix",
      "build",
      "grade",
      "ship",
    ]);
  });

  it("sorts out-of-order events by ts", () => {
    const evs = run();
    const shuffled = [evs[3]!, evs[0]!, evs[6]!, evs[1]!, evs[5]!, evs[2]!, evs[4]!];
    const s = eventsToState(shuffled);
    expect(s.steps.map((e) => e.phase)).toEqual([
      "build",
      "render",
      "grade",
      "fix",
      "build",
      "grade",
      "ship",
    ]);
  });

  it("reflects the failing scorecard before the fix lands", () => {
    const partial = run().slice(0, 3); // up to the first (failing) grade
    const s = eventsToState(partial);
    expect(s.iteration).toBe(1);
    expect(s.status).toBe("running");
    expect(s.verdict).toBe("fail");
    expect(s.passedCount).toBe(3);
    expect(s.currentScores).toEqual(failScores);
  });

  it("is queued/pending with no events", () => {
    const s = eventsToState([]);
    expect(s.status).toBe("queued");
    expect(s.verdict).toBe("pending");
    expect(s.iteration).toBe(0);
    expect(s.currentScores).toBeNull();
    expect(s.passedCount).toBe(0);
  });
});
