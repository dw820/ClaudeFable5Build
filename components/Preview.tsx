"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** A placeholder video panel (gradient + caption) — stands in until a real src. */
function VideoPanel({
  src,
  aspectBadge,
  caption,
  size,
}: {
  src?: string | null;
  aspectBadge?: string;
  caption?: React.ReactNode;
  size: "sm" | "big";
}) {
  const dims =
    size === "big"
      ? "w-[158px] shadow-soft"
      : "w-[96px] opacity-[.62]";
  return (
    <div
      className={`relative flex aspect-[9/16] items-end justify-center overflow-hidden rounded-[12px] border border-line ${dims}`}
      style={{ background: "linear-gradient(165deg,#3c4250,#222732)" }}
    >
      {src ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={src}
          controls
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <>
          {aspectBadge && (
            <span className="absolute left-[7px] top-[7px] rounded-[4px] bg-ink px-1.5 py-px text-[9px] text-white">
              {aspectBadge}
            </span>
          )}
          <div
            className={`px-2 text-center font-extrabold text-white ${
              size === "big" ? "mb-[26px] text-[15px]" : "mb-4 text-[11px]"
            }`}
            style={{ textShadow: "0 1px 8px rgba(0,0,0,.6)", letterSpacing: "-.02em" }}
          >
            {caption}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Center pane: before/after preview. "first cut" is a weak iter-1 placeholder;
 * "latest" plays the run's shipped_render when present, else a placeholder.
 */
export function Preview({
  shippedRender,
  aspect = "9:16",
  targetLenS = 30,
}: {
  shippedRender?: string | null;
  aspect?: string;
  targetLenS?: number;
}) {
  return (
    <div className="flex min-h-0 flex-col items-center overflow-auto border-r border-line p-[18px]">
      <div className="self-start text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
        Before / after preview
      </div>

      <Tabs defaultValue="after" className="mt-3 flex flex-col items-center">
        <TabsList>
          <TabsTrigger value="before">First cut</TabsTrigger>
          <TabsTrigger value="after">Latest ✓</TabsTrigger>
        </TabsList>

        <TabsContent value="before" className="mt-[14px]">
          <div className="text-center">
            <VideoPanel size="big" caption="so anyway" aspectBadge="iter 1" />
            <div className="mt-1.5 font-serif text-[15px] text-faint">
              iter 1 · weak first cut ✕
            </div>
          </div>
        </TabsContent>

        <TabsContent value="after" className="mt-[14px]">
          <div className="text-center">
            <VideoPanel
              size="big"
              src={shippedRender ?? undefined}
              aspectBadge={`0:${targetLenS} · ${aspect}`}
              caption={
                <>
                  wait for{" "}
                  <span className="rounded-[4px] bg-coral px-[5px]">the drop</span>
                </>
              }
            />
            <div className="mt-1.5 font-serif text-[15px] text-pass">
              latest · current ✓
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <p className="mt-[18px] text-center font-serif text-[17px] text-coral">
        ↳ the agent caught its own miss
      </p>
    </div>
  );
}
