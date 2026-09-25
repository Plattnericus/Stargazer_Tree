"use client";

import { useEffect, useMemo, useState } from "react";
import { frameStats, summarizeFrames, type FrameSummary } from "@/lib/frameStats";
import { useI18n, type MsgKey } from "@/lib/i18n";
import type { ResolvedGraphicsQuality } from "@/lib/quality";

const REFRESH_MS = 500;
const GREEN = "#4dff4d";

type Snapshot = FrameSummary & {
  calls: number;
  triangles: number;
  width: number;
  height: number;
  dpr: number;
};

function snapshot(): Snapshot | null {
  const frames = summarizeFrames(REFRESH_MS);
  if (!frames) return null;
  const { calls, triangles, width, height, dpr } = frameStats;
  return { ...frames, calls, triangles, width, height, dpr };
}

// Rows past this one only show from the sm breakpoint up; phones get the
// frame rate lines only.
const PHONE_ROWS = 3;

/**
 * Green in-game style performance readout in the top-right corner, below the
 * clock. Toggled in the settings (off by default); the numbers come from the
 * probe inside the Canvas, see lib/frameStats.ts. It sits under the menu
 * layer, so it never covers the settings on small screens.
 */
export default function FpsCounter({ quality }: { quality: ResolvedGraphicsQuality }) {
  const { t, locale } = useI18n();
  const [stats, setStats] = useState<Snapshot | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setStats(snapshot()), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const formats = useMemo(
    () => ({
      int: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      ms: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      compact: new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
      dpr: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    }),
    [locale],
  );

  const rows: [MsgKey, string][] = stats
    ? [
        ["stats.fps", formats.int.format(stats.fps)],
        ["stats.frameTime", `${formats.ms.format(stats.frameMs)} ms`],
        ["stats.low", formats.int.format(stats.low1)],
        ["stats.resolution", `${stats.width}×${stats.height} · ${formats.dpr.format(stats.dpr)}x`],
        ["stats.drawCalls", formats.int.format(stats.calls)],
        ["stats.triangles", formats.compact.format(stats.triangles)],
        ["settings.graphics", t(`graphics.${quality}`)],
      ]
    : [["stats.fps", "–"]];

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed right-[calc(1.25rem+env(safe-area-inset-right))] top-[calc(7.25rem+env(safe-area-inset-top))] z-[35] grid grid-cols-[auto_auto] gap-x-3 rounded-md px-2 py-1.5 font-mono text-[10px] font-semibold leading-[1.35] tabular-nums sm:top-[calc(8.5rem+env(safe-area-inset-top))] sm:text-[11px]"
      // The faint box keeps it readable over bright sky and clouds.
      style={{ color: GREEN, background: "rgba(0,0,0,0.42)", textShadow: "0 1px 1px #000" }}
    >
      {rows.map(([label, value], i) => (
        <div key={label} className={i < PHONE_ROWS ? "contents" : "hidden sm:contents"}>
          <span className="opacity-75">{t(label)}</span>
          <span className="text-end">{value}</span>
        </div>
      ))}
    </div>
  );
}
