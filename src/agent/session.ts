/**
 * Autonomous agent session (Agent SDK migration, Option C).
 *
 * Claude owns the loop; this glue fences it. It builds the tools, launches the
 * injected `query()`, enforces the wall-clock cap via `close()`, forwards the
 * message stream to Supabase `events`, and returns the SAME `LoopResult` shape
 * the deterministic `runLoop` returned — so `executeRun` is untouched downstream.
 *
 * No static SDK import: `query` and `buildServer` are injected (real ones live in
 * sdk.ts behind a dynamic import), so this file and its tests run offline.
 */
import type { ClipLibrary, LoopEvent } from "../loop/types.js";
import type { LoopResult, Rubric } from "../loop/controller.js";
import { Tracker } from "./tracker.js";
import { createAutocutTools, type ToolImpls, type ToolSpec } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

export type SdkMessage = { type: string; subtype?: string; [k: string]: unknown };
export interface QueryHandle extends AsyncIterable<SdkMessage> {
  close(): void;
}
export type QueryFn = (params: { prompt: string; options: Record<string, unknown> }) => QueryHandle;

export interface AgentCaps {
  maxTurns: number;
  maxBudgetUsd: number;
  wallclockMs: number;
}
export const DEFAULT_CAPS: AgentCaps = { maxTurns: 16, maxBudgetUsd: 1.5, wallclockMs: 180_000 };

export interface AgentSessionDeps {
  query: QueryFn;
  buildServer: (specs: ToolSpec[]) => unknown;
  toolImpls: ToolImpls;
  rubric: Rubric;
  library: ClipLibrary;
  emit?: (e: LoopEvent) => void;
  now?: () => number;
  caps?: AgentCaps;
  model?: string;
  setTimer?: (ms: number, fn: () => void) => { clear(): void };
}

function extractText(msg: SdkMessage): string {
  const content = (msg.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join(" ").trim();
}

export async function runAgentSession(
  input: { brief: string },
  deps: AgentSessionDeps,
): Promise<LoopResult> {
  const now = deps.now ?? Date.now;
  const caps = deps.caps ?? DEFAULT_CAPS;
  const setTimer =
    deps.setTimer ??
    ((ms, fn) => {
      const id = setTimeout(fn, ms);
      return { clear: () => clearTimeout(id) };
    });
  const emit = (e: Omit<LoopEvent, "ts">) => deps.emit?.({ ...e, ts: now() });

  const tracker = new Tracker(deps.rubric);
  const { specs, allowedTools } = createAutocutTools({
    impls: deps.toolImpls,
    library: deps.library,
    rubric: deps.rubric,
    tracker,
    emit,
  });
  const server = deps.buildServer(specs);
  const prompt = buildSystemPrompt(input.brief, deps.rubric);

  const q = deps.query({
    prompt,
    options: {
      model: deps.model ?? "claude-opus-4-8",
      mcpServers: { autocut: server },
      allowedTools,
      permissionMode: "bypassPermissions",
      maxTurns: caps.maxTurns,
      maxBudgetUsd: caps.maxBudgetUsd,
    },
  });

  let timedOut = false;
  const timer = setTimer(caps.wallclockMs, () => {
    timedOut = true;
    q.close();
  });

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const t = extractText(msg);
        if (t) emit({ iteration: tracker.iterations, phase: "plan", message: t.slice(0, 280) });
      }
      if (msg.type === "result") {
        const subtype = timedOut ? "wallclock" : msg.subtype ?? "success";
        return tracker.summarize(String(subtype));
      }
    }
    return tracker.summarize(timedOut ? "wallclock" : "success");
  } finally {
    timer.clear();
  }
}
