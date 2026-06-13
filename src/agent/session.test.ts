import { describe, it, expect } from "vitest";
import type { LoopEvent } from "../loop/types.js";
import { VIRAL_RUBRIC, SAMPLE_LIBRARY } from "../loop/stubs.js";
import { makeStubToolImpls, type ToolSpec } from "./tools.js";
import { runAgentSession, type QueryHandle, type SdkMessage } from "./session.js";

/** Fake buildServer: pass the specs straight through so the fake query can call them. */
const fakeBuildServer = (specs: ToolSpec[]) => ({ specs });

/** Fake query that drives the agent's tools to convergence, then ends with a result. */
function makeConvergingQuery(stopAfterPublish: boolean) {
  return (params: { prompt: string; options: Record<string, unknown> }): QueryHandle => {
    const server = (params.options.mcpServers as { autocut: { specs: ToolSpec[] } }).autocut;
    const call = (name: string, args: Record<string, unknown>) =>
      server.specs.find((s) => s.name === name)!.handler(args);
    let closed = false;
    async function* run(): AsyncGenerator<SdkMessage> {
      await call("search_clips", { query: "hook" });
      const b1 = await call("build_edl", { clipIds: ["c01"], rationale: "open on hook" });
      const edl1 = /edlId=(\S+)/.exec(b1.content[0]!.text)![1]!;
      const r1 = await call("render", { edlId: edl1 });
      const rid1 = /renderId=(\S+)/.exec(r1.content[0]!.text)![1]!;
      await call("grade", { renderId: rid1 }); // weak first grade
      yield { type: "assistant", message: { content: [{ type: "text", text: "first cut is weak, retrying" }] } };
      const b2 = await call("build_edl", { clipIds: ["c01"], rationale: "tighter" });
      const edl2 = /edlId=(\S+)/.exec(b2.content[0]!.text)![1]!;
      const r2 = await call("render", { edlId: edl2 });
      const rid2 = /renderId=(\S+)/.exec(r2.content[0]!.text)![1]!;
      await call("grade", { renderId: rid2 }); // passing grade
      if (stopAfterPublish && !closed) await call("publish", { renderId: rid2 });
      yield { type: "result", subtype: "success" };
    }
    const gen = run();
    return Object.assign(gen, { close: () => { closed = true; } });
  };
}

describe("runAgentSession", () => {
  it("drives the agent to a pass and returns a passing LoopResult", async () => {
    const events: LoopEvent[] = [];
    const res = await runAgentSession(
      { brief: "Make a beach short" },
      {
        query: makeConvergingQuery(true),
        buildServer: fakeBuildServer,
        toolImpls: makeStubToolImpls(),
        rubric: VIRAL_RUBRIC,
        library: SAMPLE_LIBRARY,
        emit: (e) => events.push(e),
        now: () => 0,
      },
    );
    expect(res.passed).toBe(true);
    expect(res.shipped).not.toBeNull();
    expect(res.stopReason).toBe("passed");
    expect(events.some((e) => e.phase === "grade")).toBe(true);
    expect(events.some((e) => e.phase === "ship")).toBe(true);
  });

  it("fires the wall-clock cap: close() is called and result maps to wallclock", async () => {
    let closeCalled = false;
    const fires: Array<() => void> = [];
    // a query that never yields a result until closed
    const hangingQuery = (params: { prompt: string; options: Record<string, unknown> }): QueryHandle => {
      async function* run(): AsyncGenerator<SdkMessage> {
        // yield nothing meaningful; wait for close() to flip the result
        while (!closeCalled) {
          yield { type: "assistant", message: { content: [] } };
          await Promise.resolve();
        }
        yield { type: "result", subtype: "success" };
      }
      const gen = run();
      return Object.assign(gen, { close: () => { closeCalled = true; } });
    };
    const res = await runAgentSession(
      { brief: "x" },
      {
        query: hangingQuery,
        buildServer: fakeBuildServer,
        toolImpls: makeStubToolImpls(),
        rubric: VIRAL_RUBRIC,
        library: SAMPLE_LIBRARY,
        now: () => 0,
        // synchronous timer: fire immediately so the test is deterministic
        setTimer: (_ms, fn) => { fires.push(fn); fn(); return { clear: () => {} }; },
      },
    );
    expect(closeCalled).toBe(true);
    expect(res.stopReason).toBe("wallclock");
  });
});
