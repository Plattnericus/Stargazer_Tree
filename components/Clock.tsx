"use client";

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { nowInZone, type ZonedParts } from "@/lib/astro";
import { GOSSENSASS } from "@/lib/location";
import { useI18n } from "@/lib/i18n";
import { TrunkRings, WOOD } from "./TrunkRings";

// Pre-rounded tick coordinates: identical strings on server and client, so
// SSR hydration never sees floating-point drift.
const TICKS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  const major = i % 3 === 0;
  const r0 = major ? 27 : 29.5;
  const f = (v: number) => Number(v.toFixed(2));
  return {
    major,
    x1: f(39 + Math.sin(a) * r0),
    y1: f(39 - Math.cos(a) * r0),
    x2: f(39 + Math.sin(a) * 31.5),
    y2: f(39 - Math.cos(a) * 31.5),
  };
});

// Top-right clock — the ONLY element up there. A small cut branch disc with
// real hands; clicking it opens the main menu (Esc does too). Live mode shows
// the real Gossensass time + sunrise/sunset; manual mode mirrors the chosen
// hour. The ticking state lives HERE, never in page.tsx, so the Canvas is not
// re-rendered every tick.
export default function Clock({
  mode,
  manualHour,
  sunrise,
  sunset,
  onOpenMenu,
}: {
  mode: "live" | "manual";
  manualHour: number;
  sunrise?: string;
  sunset?: string;
  onOpenMenu: () => void;
}) {
  const { t } = useI18n();
  const pointerOpened = useRef(false);
  // Time is read on the CLIENT only (starts null) — the server can't know the
  // visitor-moment wall time, and rendering it during SSR causes hydration
  // mismatches.
  const [now, setNow] = useState<ZonedParts | null>(null);

  useEffect(() => {
    if (mode !== "live") return;
    setNow(nowInZone(GOSSENSASS.tz));
    const id = window.setInterval(() => setNow(nowInZone(GOSSENSASS.tz)), 10 * 1000);
    return () => window.clearInterval(id);
  }, [mode]);

  const ready = mode === "manual" || now !== null;
  // Manual time may be fractional (e.g. ?hour=6.5 from the QA override):
  // show it as real minutes instead of "6.5:00".
  const manual = Math.max(0, Math.min(23 + 59 / 60, manualHour));
  const hour = mode === "live" ? (now?.hour ?? 12) : Math.floor(manual);
  const minute = mode === "live" ? (now?.minute ?? 0) : Math.round((manual - Math.floor(manual)) * 60) % 60;
  const label = ready
    ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    : "--:--";

  const hourAngle = ((hour % 12) + minute / 60) * 30;
  const minuteAngle = minute * 6;

  const times = useMemo(() => {
    const fmt = (iso?: string) => {
      if (!iso) return null;
      const m = /T(\d{2}:\d{2})/.exec(iso);
      return m ? m[1] : null;
    };
    return { rise: fmt(sunrise), set: fmt(sunset) };
  }, [sunrise, sunset]);

  const openMenu = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu();
  };

  return (
    <div className="anim-slide-right absolute right-[calc(1.25rem+env(safe-area-inset-right))] top-[calc(1.25rem+env(safe-area-inset-top))] z-30 flex items-start gap-2.5">
      {(times.rise || times.set) && (
        <div
          className="mt-2 hidden flex-col items-end gap-0.5 text-[10px] font-medium tabular-nums sm:flex"
          style={{ color: WOOD.textDim, textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}
        >
          {times.rise && <span>↑ {times.rise}</span>}
          {times.set && <span>↓ {times.set}</span>}
        </div>
      )}
      <button
        type="button"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onPointerUp={(event) => {
          pointerOpened.current = true;
          openMenu(event);
          window.setTimeout(() => {
            pointerOpened.current = false;
          }, 0);
        }}
        onClick={(event) => {
          if (pointerOpened.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          openMenu(event);
        }}
        aria-label={t("a11y.menu")}
        className="clock-btn relative h-[62px] w-[62px] drop-shadow-[0_6px_14px_rgba(0,0,0,0.45)] transition hover:scale-[1.04] active:scale-95 sm:h-[78px] sm:w-[78px]"
        style={{ touchAction: "manipulation" }}
      >
        <TrunkRings size={78} seed={4211} rings={6} className="absolute inset-0 h-full w-full" />
        <svg viewBox="0 0 78 78" className="absolute inset-0 h-full w-full" aria-hidden>
          {/* carved hour ticks */}
          {TICKS.map((tick, i) => (
            <line
              key={i}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke={WOOD.ringLight}
              strokeWidth={tick.major ? 1.6 : 0.9}
              opacity={0.7}
            />
          ))}
          <g style={{ opacity: ready ? 1 : 0 }}>
            <g transform={`rotate(${hourAngle} 39 39)`}>
              <line x1="39" y1="41" x2="39" y2="23" stroke={WOOD.text} strokeWidth="2.8" strokeLinecap="round" />
            </g>
            <g transform={`rotate(${minuteAngle} 39 39)`}>
              <line x1="39" y1="42" x2="39" y2="16" stroke={WOOD.ringLight} strokeWidth="1.7" strokeLinecap="round" />
            </g>
            <circle cx="39" cy="39" r="2.4" fill={WOOD.accent} />
          </g>
        </svg>
        <span
          className="absolute inset-x-0 -bottom-4 text-center text-[11px] font-semibold tabular-nums"
          style={{ color: WOOD.text, textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
        >
          {label}
        </span>
      </button>
    </div>
  );
}
