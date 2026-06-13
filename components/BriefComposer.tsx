"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardWindow } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const STYLES = ["Viral Short", "Cinematic", "Explainer"] as const;
const ASPECTS = ["9:16", "1:1", "16:9"] as const;
const LENGTHS = ["15s", "30s", "60s"] as const;

function Field({
  label,
  hint,
  value,
  children,
}: {
  label: string;
  hint?: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-[9px] flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
          {label}
          {hint && (
            <span className="ml-1 normal-case tracking-normal text-faint">
              {hint}
            </span>
          )}
        </span>
        {value && (
          <span className="font-serif text-[18px] text-ink">{value}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Setup-screen brief: pills + concept textarea → POST /api/generate → /run/[id]. */
export function BriefComposer() {
  const router = useRouter();
  const [style, setStyle] = useState<string>(STYLES[0]);
  const [aspect, setAspect] = useState<string>(ASPECTS[0]);
  const [length, setLength] = useState<string>(LENGTHS[1]);
  const [concept, setConcept] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: concept,
          style,
          aspect,
          length: Number.parseInt(length, 10),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Couldn't start the run, retry.");
      }
      const { runId } = (await res.json()) as { runId: string };
      router.push(`/run/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the run, retry.");
      setSubmitting(false);
    }
  }

  return (
    <Card className="flex min-h-0 flex-col">
      <CardWindow title="the brief" />
      <div className="flex flex-1 flex-col gap-[18px] overflow-auto p-5">
        <Field label="Style">
          <ToggleGroup
            type="single"
            value={style}
            onValueChange={(v) => v && setStyle(v)}
          >
            {STYLES.map((s) => (
              <ToggleGroupItem key={s} value={s}>
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Field label="Aspect">
          <ToggleGroup
            type="single"
            value={aspect}
            onValueChange={(v) => v && setAspect(v)}
          >
            {ASPECTS.map((a) => (
              <ToggleGroupItem key={a} value={a} square>
                {a}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Field label="Length" value={length}>
          <ToggleGroup
            type="single"
            value={length}
            onValueChange={(v) => v && setLength(v)}
          >
            {LENGTHS.map((l) => (
              <ToggleGroupItem key={l} value={l} square>
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Field label="Concept / notes" hint="(optional)">
          <Textarea
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            placeholder="Open on the wipeout, build to the sunset, loop back to the first frame."
          />
        </Field>

        {error && <p className="text-[12px] text-fail">{error}</p>}

        <Button size="lg" onClick={generate} disabled={submitting}>
          {submitting ? "Starting…" : "Generate ▶"}
        </Button>
      </div>
    </Card>
  );
}
