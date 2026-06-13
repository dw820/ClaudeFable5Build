"use client";

import { useEffect, useState } from "react";
import { Card, CardWindow } from "@/components/ui/card";

/** The fields of a clips.json clip the library grid renders. */
interface Clip {
  id: string;
  src: string;
  duration: number;
  caption: string;
  /** Public URL of a pre-generated poster frame; absent clips fall back to the film icon. */
  thumbnail?: string;
}

interface ClipLibrary {
  projectId: string;
  clips: Clip[];
}

function FilmIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-[15px] w-[15px]"
      aria-hidden
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M10 9.5l4 2.5-4 2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function fmt(seconds: number): string {
  const s = Math.round(seconds);
  return `:${String(s).padStart(2, "0")}`;
}

/** Setup-screen footage library: the pre-baked clips.json the agent reasons over. */
export function Library() {
  const [lib, setLib] = useState<ClipLibrary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/clips.json")
      .then((r) => r.json())
      .then((data: ClipLibrary) => {
        if (!cancelled) setLib(data);
      })
      .catch(() => {
        /* clips.json is a static demo asset; absence shows the empty grid. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clips = lib?.clips ?? [];
  const totalS = clips.reduce((n, c) => n + c.duration, 0);
  const mins = Math.floor(totalS / 60);
  const secs = Math.round(totalS % 60);

  return (
    <Card className="flex min-h-0 flex-col">
      <CardWindow title={`footage · ${lib?.projectId ?? "library"}`} showUrl />
      <div className="flex-1 overflow-auto p-[18px]">
        <div className="mb-4 rounded-[12px] border-[1.5px] border-dashed border-line bg-sink p-5 text-center">
          <div className="text-[22px] text-faint">⬆</div>
          <div className="mt-1 text-sm text-muted">Drop raw clips here</div>
          <div className="text-[11.5px] text-faint">or browse · mp4, mov</div>
        </div>

        <div className="mb-[11px] flex items-baseline justify-between">
          <span className="text-[13.5px] font-medium text-text">
            {clips.length} clips indexed
          </span>
          <span className="text-[12px] text-faint">
            {mins}m {String(secs).padStart(2, "0")}s · transcript · scene · embed
          </span>
        </div>

        <div className="mb-4 grid grid-cols-5 gap-[9px]">
          {clips.map((clip) => (
            <div
              key={clip.id}
              className="relative flex aspect-[9/13] items-center justify-center rounded-[8px] border border-line bg-[var(--sink)] text-faint"
              title={clip.caption}
            >
              {clip.thumbnail ? (
                <img
                  src={clip.thumbnail}
                  alt={clip.caption}
                  loading="lazy"
                  className="absolute inset-0 h-full w-full rounded-[8px] object-cover"
                />
              ) : (
                <FilmIcon />
              )}
              <span className="absolute bottom-1 right-1 rounded-[3px] bg-ink px-1 text-[9px] text-white tnum">
                {fmt(clip.duration)}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2.5 rounded-[10px] border border-line bg-sink px-[13px] py-[11px]">
          <span className="text-[15px]">📄</span>
          <div>
            <div className="text-[13px] text-text">
              writes <b className="font-semibold">clips.json</b>
            </div>
            <div className="text-[11px] text-faint">
              ✓ transcript ✓ scene · the agent reasons over this directly
            </div>
          </div>
          <span className="ml-auto rounded-md bg-passSoft px-2.5 py-[3px] text-[11px] font-semibold text-pass">
            ready
          </span>
        </div>
      </div>
    </Card>
  );
}
