/**
 * The ONLY file that imports @anthropic-ai/claude-agent-sdk.
 *
 * Dynamic import keeps the rest of src/agent/ (and its tests) SDK-free and
 * offline, exactly like agent-server.ts dynamically imports @supabase/supabase-js
 * at its entry point. Provides the real `query` and `buildServer` that
 * runAgentSession injects in production.
 */
import type { QueryFn, QueryHandle } from "./session.js";
import type { ToolSpec } from "./tools.js";

/** Real `query`: adapt the SDK's AsyncGenerator (with .interrupt/.close) to QueryHandle. */
export async function makeRealQuery(): Promise<QueryFn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => {
    const q = query(params as never) as AsyncGenerator<unknown> & {
      close?: () => void;
      interrupt?: () => Promise<void>;
    };
    const handle = q as unknown as QueryHandle;
    // Normalize cancellation onto close(): prefer the SDK's close(), fall back to interrupt().
    if (typeof q.close !== "function") {
      (handle as { close: () => void }).close = () => {
        void q.interrupt?.();
      };
    }
    return handle;
  };
}

/** Real `buildServer`: turn our SDK-agnostic specs into an in-process MCP server. */
export async function makeRealBuildServer(): Promise<(specs: ToolSpec[]) => unknown> {
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  return (specs: ToolSpec[]) =>
    createSdkMcpServer({
      name: "autocut",
      tools: specs.map((s) => tool(s.name, s.description, s.schema, s.handler as never)),
    });
}
