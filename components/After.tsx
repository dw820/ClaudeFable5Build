"use client";

import type { Grade } from "@/lib/contracts";
import { Card, CardWindow } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** Seeded engagement tiles — the deferred outer loop, shown for narrative (§0c). */
const TILES = [
  { n: "14.2k", l: "views" },
  { n: "61%", l: "retention" },
  { n: "3.1×", l: "loops" },
];

function scoreLines(scores: Grade["scores"] | null) {
  if (!scores) {
    return [
      { label: "Hook", value: "8" },
      { label: "Pace", value: "9" },
      { label: "Captions", value: "8" },
      { label: "Loop · On-style", value: "8 · 9" },
    ];
  }
  return [
    { label: "Hook", value: String(scores.hook_strength) },
    { label: "Pace", value: String(scores.pace_cut_density) },
    { label: "Captions", value: String(scores.caption_legibility) },
    {
      label: "Loop · On-style",
      value: `${scores.loopability} · ${scores.on_style_trend_fit}`,
    },
  ];
}

/**
 * After-the-loop view: ship/publish the passing render + the seeded engagement
 * and learned-memory narrative. All static per §0c (the outer loop is deferred).
 */
export function After({
  scores,
  shippedRender,
}: {
  scores: Grade["scores"] | null;
  shippedRender?: string | null;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-5">
      {/* ship & publish */}
      <Card>
        <CardWindow title="ship & publish" />
        <div className="flex gap-5 p-5">
          <div
            className="relative flex aspect-[9/16] w-[132px] flex-none items-center justify-center overflow-hidden rounded-[13px] border border-line shadow-soft"
            style={{ background: "linear-gradient(165deg,#3c4250,#222732)" }}
          >
            {shippedRender ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={shippedRender}
                controls
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 border-white">
                <svg viewBox="0 0 24 24" className="h-3 w-3 fill-white">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            )}
            <span className="absolute right-2 top-2 rounded-[4px] bg-pass px-1.5 py-px text-[9px] font-bold text-white">
              5/5
            </span>
          </div>

          <div className="flex-1">
            <span className="mb-[14px] inline-block rounded-full border border-pass bg-passSoft px-[13px] py-1 font-serif text-[16px] font-semibold text-pass">
              ✓ Ship-ready
            </span>
            {scoreLines(scores).map((row) => (
              <div
                key={row.label}
                className="flex justify-between border-b border-line py-1 text-[12.5px] text-muted"
              >
                <span>{row.label}</span>
                <span className="font-semibold text-pass tnum">{row.value}</span>
              </div>
            ))}
            <div className="my-[14px] flex gap-2">
              <Button variant="outline" className="flex-1 rounded-[9px]">
                Platform ▾
              </Button>
              <Button variant="outline" className="flex-1 rounded-[9px]">
                ⬇ download
              </Button>
            </div>
            <Button className="w-full">Publish ↗</Button>
            <div className="mt-[7px] text-center text-[10.5px] text-faint">
              deferred for demo · recorded backup ready
            </div>
          </div>
        </div>
      </Card>

      {/* engagement & memory */}
      <Card>
        <CardWindow title="engagement & memory · outer loop ↩" />
        <div className="p-5">
          <div className="mb-4 grid grid-cols-3 gap-2.5">
            {TILES.map((t) => (
              <div
                key={t.l}
                className="rounded-[10px] border border-line bg-card p-[11px] text-center"
              >
                <div className="font-serif text-[23px] font-semibold text-ink">
                  {t.n}
                </div>
                <div className="mt-px text-[10px] text-faint">{t.l}</div>
              </div>
            ))}
          </div>

          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
            Retention curve
          </div>
          <div className="relative mb-4 h-[84px] overflow-hidden rounded-[10px] border border-line bg-card">
            <svg
              viewBox="0 0 300 84"
              preserveAspectRatio="none"
              className="h-full w-full"
            >
              <polyline
                points="0,14 40,20 90,33 150,46 220,58 300,66"
                fill="none"
                stroke="var(--blue)"
                strokeWidth="3"
                strokeLinejoin="round"
              />
              <line
                x1="60"
                y1="0"
                x2="60"
                y2="84"
                stroke="var(--coral)"
                strokeWidth="2"
                strokeDasharray="4 4"
              />
            </svg>
            <div className="absolute left-[64px] top-[7px] font-serif text-[13px] text-coral">
              2s hook
            </div>
          </div>

          <div className="rounded-[11px] border-[1.5px] border-[var(--blue)] bg-[#E9F0F8] p-[13px]">
            <div className="mb-1.5 flex items-center gap-[7px] text-[11.5px] font-bold uppercase tracking-[0.03em] text-[var(--blue)]">
              <span>🧠</span> Memory rule learned
            </div>
            <div className="font-serif text-[16px] leading-[1.3] text-ink">
              &quot;First-2s hook drives retention for Viral Short.&quot;
            </div>
            <div className="mt-2 text-[12.5px] text-[var(--blue)]">
              ↩ consulted on the next brief
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
