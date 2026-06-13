"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRunEvents } from "@/lib/useRunEvents";
import { Header } from "@/components/Header";
import { Card, CardWindow } from "@/components/ui/card";
import { AgentSteps } from "@/components/AgentSteps";
import { Preview } from "@/components/Preview";
import { Scorecard } from "@/components/Scorecard";
import { After } from "@/components/After";

interface RunRow {
  aspect: string | null;
  target_len_s: number | null;
  status: string | null;
  shipped_render: string | null;
}

/** Live run row (aspect / length / shipped render). Realtime-updated. */
function useRun(runId: string): RunRow | null {
  const [run, setRun] = useState<RunRow | null>(null);

  useEffect(() => {
    if (!runId) return;
    const supabase = supabaseBrowser();
    let cancelled = false;

    void supabase
      .from("runs")
      .select("aspect, target_len_s, status, shipped_render")
      .eq("id", runId)
      .single()
      .then(({ data }) => {
        if (!cancelled && data) setRun(data as RunRow);
      });

    const channel = supabase
      .channel(`run-row:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "runs",
          filter: `id=eq.${runId}`,
        },
        (payload) => setRun(payload.new as RunRow),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [runId]);

  return run;
}

/** Generation 3-pane theater + the After reveal once the run ships. */
export function RunView({ runId }: { runId: string }) {
  const state = useRunEvents(runId);
  const run = useRun(runId);
  // An event 'ship' OR a runs.status='shipped' flips us to the After view.
  const shipped = state.status === "shipped" || run?.status === "shipped";

  return (
    <main className="mx-auto flex h-screen max-w-[1240px] flex-col px-[26px] pb-[18px] pt-5">
      <Header active={shipped ? "after" : "generation"} />

      {shipped ? (
        <>
          <div className="mb-[14px] flex items-baseline gap-3">
            <h2 className="font-serif text-[24px] font-semibold tracking-[-0.02em] text-ink">
              After the loop
            </h2>
            <p className="text-[13px] text-muted">
              Ship the passing render — then engagement + memory steer the next
              run.
            </p>
          </div>
          <After scores={state.currentScores} shippedRender={run?.shipped_render} />
        </>
      ) : (
        <>
          <div className="mb-[14px] flex items-baseline gap-3">
            <h2 className="font-serif text-[24px] font-semibold tracking-[-0.02em] text-ink">
              Generate — the live loop
            </h2>
            <p className="text-[13px] text-muted">
              Agent steps · before/after preview · the rubric scorecard.
            </p>
          </div>
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardWindow
              title={
                state.verdict === "fail"
                  ? "autocut · self-correcting"
                  : "autocut · generating"
              }
              showUrl
            />
            <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.15fr_296px]">
              <AgentSteps steps={state.steps} />
              <Preview
                shippedRender={run?.shipped_render}
                aspect={run?.aspect ?? "9:16"}
                targetLenS={run?.target_len_s ?? 30}
              />
              <Scorecard
                scores={state.currentScores}
                iteration={state.iteration}
                verdict={state.verdict}
                passedCount={state.passedCount}
              />
            </div>
          </Card>
        </>
      )}
    </main>
  );
}
