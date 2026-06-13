import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/server";

// Service-role Supabase client is Node-only.
export const runtime = "nodejs";

/**
 * Enqueue a run. The UI talks to the agent ONLY through Supabase: this inserts a
 * `runs` row with status='queued' and returns its id. The Daytona agent (another
 * lane) picks it up and writes `events` rows; the UI subscribes to those. This
 * route does NOT run the loop.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { brief, style, aspect, length } = (body ?? {}) as {
    brief?: unknown;
    style?: unknown;
    aspect?: unknown;
    length?: unknown;
  };

  if (typeof style !== "string" || typeof aspect !== "string") {
    return NextResponse.json(
      { error: "style and aspect are required" },
      { status: 400 },
    );
  }

  const targetLen = Number(length);

  const supabase = supabaseService();
  const { data, error } = await supabase
    .from("runs")
    .insert({
      brief: typeof brief === "string" ? brief : "",
      style,
      aspect,
      target_len_s: Number.isFinite(targetLen) ? targetLen : 30,
      status: "queued",
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "failed to enqueue run" },
      { status: 500 },
    );
  }

  return NextResponse.json({ runId: data.id });
}
