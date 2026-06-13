"use client";

/**
 * Live run state for the Generation screen. Seeds with a one-shot select of any
 * events already written (so a late-joining / reconnecting UI never shows blank,
 * per §0b failure table), then subscribes to Supabase Realtime INSERTs on
 * `events` for this run and folds everything through the pure reducer.
 */
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { LoopEvent } from "@/lib/contracts";
import { eventsToState, type RunState } from "@/lib/eventsToState";

/** Shape of an `events` table row (snake_case columns → LoopEvent). */
interface EventRow {
  iteration: number;
  phase: LoopEvent["phase"];
  message: string;
  scores?: LoopEvent["scores"] | null;
  render_ref?: string | null;
  ts: number | string;
}

function rowToEvent(row: EventRow): LoopEvent {
  return {
    iteration: row.iteration,
    phase: row.phase,
    message: row.message,
    scores: row.scores ?? undefined,
    renderRef: row.render_ref ?? undefined,
    ts: typeof row.ts === "string" ? Date.parse(row.ts) : row.ts,
  };
}

export function useRunEvents(runId: string): RunState {
  const [events, setEvents] = useState<LoopEvent[]>([]);

  useEffect(() => {
    if (!runId) return;
    const supabase = supabaseBrowser();
    let cancelled = false;

    void supabase
      .from("events")
      .select("iteration, phase, message, scores, render_ref, ts")
      .eq("run_id", runId)
      .order("ts", { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setEvents(data.map((r) => rowToEvent(r as EventRow)));
      });

    const channel = supabase
      .channel(`run:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "events",
          filter: `run_id=eq.${runId}`,
        },
        (payload) => {
          setEvents((prev) => [...prev, rowToEvent(payload.new as EventRow)]);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [runId]);

  return eventsToState(events);
}
