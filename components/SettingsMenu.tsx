"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import gsap from "gsap";
import { seasonFromMonth, type Sky, type Weather } from "@/lib/weather";
import {
  GRAPHICS_OPTIONS,
  type GraphicsQuality,
  type ResolvedGraphicsQuality,
} from "@/lib/quality";
import { MAX_FOV, MIN_FOV } from "@/lib/cameraBus";
import { detectLocale, LOCALE_FLAG, LOCALE_LABEL, LOCALES, useI18n, type MsgKey } from "@/lib/i18n";
import { TrunkRings, WOOD } from "./TrunkRings";
import {
  CalendarIcon,
  ClockIcon,
  CloseIcon,
  CloudIcon,
  FogIcon,
  MinusIcon,
  PlusIcon,
  RainIcon,
  SnowIcon,
  StarIcon,
  StormIcon,
  SunIcon,
  WindIcon,
} from "./Icons";

export type { GraphicsQuality } from "@/lib/quality";

const SKIES: Sky[] = ["clear", "clouds", "fog", "rain", "snow", "storm"];

// Condition accents reuse the scene palette so the panel stays visually connected.
const SKY_ACCENT: Record<Sky, string> = {
  clear: "#e6b25a",
  clouds: "#9fb2bd",
  fog: "#aeb7b5",
  rain: "#6aa6e0",
  snow: "#dfeaf2",
  storm: "#9b8cf0",
};

const SEASON_ACCENT: Record<string, string> = {
  spring: "#8fce5a",
  summer: "#5aa238",
  autumn: "#d98a3a",
  winter: "#8fc6e6",
};

const SKY_ICON: Record<Sky, ComponentType<{ className?: string }>> = {
  clear: SunIcon,
  clouds: CloudIcon,
  fog: FogIcon,
  rain: RainIcon,
  snow: SnowIcon,
  storm: StormIcon,
};

export type ManualDate = {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
};

type Credit = { model: string; author: string; source: string; license: string };

// Creative Commons ids as written in CREDITS.md ("CC-BY-4.0",
// "CC-BY-NC-SA-4.0") map to their license deed, which attribution under
// those licenses has to point to.
function licenseUrl(license: string): string | null {
  const m = /^CC-(BY(?:-NC)?(?:-SA|-ND)?)-(\d\.\d)$/i.exec(license.trim());
  return m ? `https://creativecommons.org/licenses/${m[1].toLowerCase()}/${m[2]}/` : null;
}
type Tab = "settings" | "credits";

function relTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function countdown(ms: number | null): string {
  if (ms === null) return "--:--";
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function cardinal(deg: number | undefined): string {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return "--";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % dirs.length];
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[10px] font-bold uppercase tracking-[0.16em]"
        style={{ color: WOOD.ringLight, textShadow: "0 1px 0 rgba(0,0,0,0.55)" }}
      >
        {children}
      </span>
      <span
        className="h-px flex-1"
        style={{ background: `linear-gradient(90deg, ${WOOD.ringDark}aa, transparent)` }}
      />
    </div>
  );
}

const INSET_BOX = {
  borderColor: "rgba(20,12,4,0.85)",
  background: "linear-gradient(180deg, rgba(14,8,2,0.5), rgba(24,15,6,0.35))",
  boxShadow: "inset 0 2px 6px rgba(0,0,0,0.55), 0 1px 0 rgba(201,168,110,0.14)",
} as const;

// Segmented control with a GSAP-animated sliding thumb — one component drives
// the tabs, the auto/manual switch and the graphics selector so every switch
// in the menu moves with the same clean spring.
function SlidingTabs<T extends string>({
  options,
  value,
  onChange,
  render,
  thumbBackground,
  activeColor,
  inactiveColor,
  size = "text-xs",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  render: (v: T) => React.ReactNode;
  thumbBackground: (v: T) => string;
  activeColor?: (v: T) => string;
  inactiveColor?: (v: T) => string;
  size?: string;
}) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef(true);
  const idx = Math.max(0, options.indexOf(value));
  const count = options.length;

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (firstRef.current) {
      firstRef.current = false;
      gsap.set(el, { xPercent: idx * 100 });
      return;
    }
    gsap.to(el, { xPercent: idx * 100, duration: reduced ? 0 : 0.42, ease: "back.out(1.6)" });
  }, [idx]);

  return (
    <div
      className="relative grid rounded-xl border p-1"
      style={{ ...INSET_BOX, gridTemplateColumns: `repeat(${count}, 1fr)` }}
    >
      <div
        ref={thumbRef}
        className="pointer-events-none absolute rounded-lg"
        style={{
          left: 4,
          top: 4,
          bottom: 4,
          width: `calc((100% - 8px) / ${count})`,
          background: thumbBackground(value),
          boxShadow: "0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.18)",
          transition: "background 220ms ease",
        }}
      />
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`relative z-10 rounded-lg py-2 font-bold transition-colors duration-200 ${size}`}
          style={{
            color:
              value === o ? (activeColor?.(o) ?? WOOD.barkDark) : (inactiveColor?.(o) ?? WOOD.textDim),
          }}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

// Language picker that expands IN PLACE (GSAP height) — it pushes the content
// below instead of floating over it, so nothing can ever overlap.
function LanguageSelect() {
  const { locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (firstRef.current) {
      firstRef.current = false;
      gsap.set(el, { height: 0, autoAlpha: 0, display: "none" });
      return;
    }
    if (open) {
      gsap.set(el, { display: "block" });
      gsap.fromTo(
        el,
        { height: 0, autoAlpha: 0 },
        { height: "auto", autoAlpha: 1, duration: reduced ? 0 : 0.35, ease: "power3.out", clearProps: "height" },
      );
      gsap.fromTo(
        el.querySelectorAll("button"),
        { autoAlpha: 0, x: -8 },
        { autoAlpha: 1, x: 0, duration: reduced ? 0 : 0.24, stagger: 0.02, ease: "power2.out", delay: 0.05 },
      );
    } else {
      gsap.to(el, {
        height: 0,
        autoAlpha: 0,
        duration: reduced ? 0 : 0.26,
        ease: "power2.inOut",
        onComplete: () => gsap.set(el, { display: "none" }),
      });
    }
  }, [open]);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-[12.5px] font-bold transition hover:brightness-110"
        style={{ ...INSET_BOX, color: WOOD.text }}
      >
        <span className="flex items-center gap-2">
          <span aria-hidden>{LOCALE_FLAG[locale]}</span>
          {LOCALE_LABEL[locale]}
        </span>
        <span
          aria-hidden
          className="transition-transform duration-300"
          style={{ color: WOOD.accent, transform: open ? "rotate(180deg)" : "none" }}
        >
          ▾
        </span>
      </button>
      <div ref={listRef} className="overflow-hidden" style={{ height: 0, opacity: 0, display: "none" }}>
        <div
          className="menu-lang-list mt-1 max-h-[248px] overflow-y-auto rounded-xl border"
          style={{
            borderColor: "rgba(20,12,4,0.85)",
            background: "rgba(0,0,0,0.28)",
            boxShadow: "inset 0 2px 8px rgba(0,0,0,0.45)",
          }}
        >
          {LOCALES.map((l) => (
            <button
              key={l}
              onClick={() => {
                setLocale(l);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2.5 text-[12.5px] font-bold transition hover:brightness-125"
              style={{
                color: locale === l ? WOOD.text : WOOD.textDim,
                background: locale === l ? "rgba(201,168,110,0.14)" : "transparent",
              }}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>{LOCALE_FLAG[l]}</span>
                {LOCALE_LABEL[l]}
              </span>
              {locale === l && <span style={{ color: WOOD.accent }}>✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// "You are leaving the site" confirmation — pops over the trunk panel with a
// GSAP entrance before any external credit link opens.
function ExternalLinkConfirm({
  url,
  model,
  onClose,
}: {
  url: string;
  model: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      gsap.set([root, card], { autoAlpha: 1 });
      return;
    }
    gsap.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.22, ease: "power2.out" });
    gsap.fromTo(
      card,
      { autoAlpha: 0, scale: 0.86, y: 14, rotateX: 6 },
      { autoAlpha: 1, scale: 1, y: 0, rotateX: 0, duration: 0.38, ease: "back.out(1.7)" },
    );
    gsap.fromTo(
      card.querySelectorAll("[data-pop-item]"),
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, y: 0, duration: 0.26, stagger: 0.06, ease: "power2.out", delay: 0.1 },
    );
  }, []);

  const dismiss = (thenOpen: boolean) => {
    const root = rootRef.current;
    const card = cardRef.current;
    const done = () => {
      if (thenOpen) window.open(url, "_blank", "noopener,noreferrer");
      onClose();
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!root || !card || reduced) {
      done();
      return;
    }
    gsap.to(card, { autoAlpha: 0, scale: 0.92, y: 8, duration: 0.18, ease: "power2.in" });
    gsap.to(root, { autoAlpha: 0, duration: 0.2, ease: "power2.in", onComplete: done });
  };

  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* show raw url */
  }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-30 grid place-items-center p-5 opacity-0"
      style={{ background: "rgba(8,4,1,0.72)", borderRadius: "inherit" }}
      onClick={() => dismiss(false)}
    >
      <div
        ref={cardRef}
        className="w-full max-w-[320px] rounded-2xl border p-4 text-center opacity-0"
        onClick={(e) => e.stopPropagation()}
        style={{
          borderColor: WOOD.barkDark,
          background: `radial-gradient(circle at 45% 25%, ${WOOD.woodMid}, ${WOOD.woodDeep} 70%, ${WOOD.barkMid})`,
          boxShadow:
            "0 22px 50px rgba(0,0,0,0.6), inset 0 0 0 2px rgba(58,39,18,0.9), inset 0 0 0 4px rgba(201,168,110,0.14)",
        }}
      >
        <div data-pop-item className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full border text-lg" style={{ ...INSET_BOX, color: WOOD.accent }}>
          ↗
        </div>
        <h3 data-pop-item className="text-[13.5px] font-bold" style={{ color: WOOD.text }}>
          {t("external.title")}
        </h3>
        <p data-pop-item className="mt-1 text-[11px]" style={{ color: WOOD.textDim }}>
          {t("external.body")}
        </p>
        <p
          data-pop-item
          className="mx-auto mt-2 w-fit max-w-full truncate rounded-lg border px-2.5 py-1 text-[11px] font-bold tabular-nums"
          style={{ ...INSET_BOX, color: WOOD.accent }}
          title={url}
        >
          {host} · {model}
        </p>
        <div data-pop-item className="mt-3.5 grid grid-cols-2 gap-1.5">
          <button
            onClick={() => dismiss(false)}
            className="rounded-xl border py-2 text-[11.5px] font-bold transition hover:brightness-125"
            style={{ ...INSET_BOX, color: WOOD.textDim }}
          >
            {t("reset.no")}
          </button>
          <button
            onClick={() => dismiss(true)}
            className="rounded-xl py-2 text-[11.5px] font-bold transition hover:brightness-110 active:scale-95"
            style={{
              background: `linear-gradient(180deg, ${WOOD.accent}, #b8842f)`,
              color: WOOD.barkDark,
              boxShadow: "0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
          >
            {t("external.open")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Main menu — a cut tree trunk opened CENTERED over the scene (Esc or the
 * clock opens it). One tidy column: stars → weather (auto/manual switch, the
 * manual panel only unfolds when manual is active) → graphics → language →
 * reset. Fully controlled by `open`.
 */
export default function SettingsMenu({
  weather,
  mode,
  date,
  manualSky,
  stars,
  devControls,
  onChangeStars,
  starsLive,
  lastSync,
  nextSync,
  graphicsQuality,
  resolvedGraphicsQuality,
  fov,
  showFps,
  open,
  onOpenChange,
  onMode,
  onDate,
  onSky,
  onGraphicsQuality,
  onFov,
  onShowFps,
  onReset,
}: {
  weather: Weather | null;
  mode: "live" | "manual";
  date: ManualDate;
  manualSky: Sky;
  stars: number;
  devControls: boolean;
  onChangeStars: (n: number) => void;
  starsLive: boolean;
  lastSync: number | null;
  nextSync: number | null;
  graphicsQuality: GraphicsQuality;
  resolvedGraphicsQuality: ResolvedGraphicsQuality;
  fov: number;
  showFps: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMode: (m: "live" | "manual") => void;
  onDate: (d: ManualDate) => void;
  onSky: (s: Sky) => void;
  onGraphicsQuality: (q: GraphicsQuality) => void;
  onFov: (n: number) => void;
  onShowFps: (on: boolean) => void;
  onReset: () => void;
}) {
  const { t, setLocale } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("settings");
  const [credits, setCredits] = useState<Credit[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmLink, setConfirmLink] = useState<Credit | null>(null);
  const [, setTick] = useState(0); // drives the live "synced … ago" readout
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const unfoldRef = useRef<HTMLDivElement>(null);
  const prevMode = useRef<"live" | "manual" | null>(null);
  const season = seasonFromMonth(Math.min(11, Math.max(0, date.month - 1)));
  const seasonColor = SEASON_ACCENT[season];
  const nextMs = nextSync ? Math.max(0, nextSync - Date.now()) : null;
  const syncWindow = lastSync && nextSync ? Math.max(1, nextSync - lastSync) : 1;
  const syncProgress =
    lastSync && nextSync
      ? Math.min(100, Math.max(0, ((Date.now() - lastSync) / syncWindow) * 100))
      : 0;

  useEffect(() => {
    if (open) setMounted(true);
    else setConfirmReset(false);
  }, [open]);

  useEffect(() => {
    if (tab !== "credits" || credits !== null) return;
    fetch("/api/credits")
      .then((r) => r.json())
      .then((d) => setCredits(Array.isArray(d.credits) ? d.credits : []))
      .catch(() => setCredits([]));
  }, [tab, credits]);

  useEffect(() => {
    if (!mounted || !open) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [mounted, open]);

  // Manual panel unfolds/folds with GSAP; the header above NEVER moves because
  // the panel is anchored to a fixed top offset (not re-centered).
  useEffect(() => {
    const el = unfoldRef.current;
    if (!el) {
      prevMode.current = null;
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const show = mode === "manual";
    if (prevMode.current === null || prevMode.current === mode || reduced) {
      gsap.set(
        el,
        show
          ? { height: "auto", autoAlpha: 1, display: "block" }
          : { height: 0, autoAlpha: 0, display: "none" },
      );
    } else if (show) {
      gsap.set(el, { display: "block" });
      gsap.fromTo(
        el,
        { height: 0, autoAlpha: 0 },
        { height: "auto", autoAlpha: 1, duration: 0.45, ease: "power3.out", clearProps: "height" },
      );
    } else {
      gsap.to(el, {
        height: 0,
        autoAlpha: 0,
        duration: 0.32,
        ease: "power2.inOut",
        onComplete: () => gsap.set(el, { display: "none" }),
      });
    }
    prevMode.current = mode;
  }, [mode, mounted, tab]);

  // Centered entrance: backdrop fade + panel settle.
  useEffect(() => {
    if (!mounted || !panelRef.current || !backdropRef.current) return;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const items = panel.querySelectorAll<HTMLElement>("[data-menu-item]");
    gsap.killTweensOf([panel, backdrop, ...Array.from(items)]);

    if (open) {
      if (reduced) {
        gsap.set([panel, backdrop], { autoAlpha: 1, scale: 1, y: 0 });
        return;
      }
      gsap.set(items, { autoAlpha: 1, y: 0 });
      gsap.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18, ease: "power2.out" });
      gsap
        .timeline()
        .fromTo(
          panel,
          { autoAlpha: 0, scale: 1.025, y: -8, transformOrigin: "center" },
          { autoAlpha: 1, scale: 1, y: 0, duration: 0.24, ease: "power3.out" },
        );
      return;
    }

    if (reduced) {
      gsap.set([panel, backdrop], { autoAlpha: 0 });
      setMounted(false);
      return;
    }
    gsap.to(backdrop, { autoAlpha: 0, duration: 0.16, ease: "power2.in" });
    gsap.to(panel, {
      autoAlpha: 0,
      scale: 0.985,
      y: 6,
      duration: 0.16,
      ease: "power2.inOut",
      onComplete: () => setMounted(false),
    });
  }, [mounted, open]);

  const num = (
    labelKey: MsgKey,
    key: keyof ManualDate,
    min: number,
    max: number,
    icon?: ComponentType<{ className?: string }>,
  ) => (
    <label className="flex flex-col gap-1">
      <span
        className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em]"
        style={{ color: WOOD.textDim }}
      >
        {icon &&
          (() => {
            const Icon = icon;
            return <Icon className="h-3 w-3" />;
          })()}
        {t(labelKey)}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={date[key]}
        onChange={(e) => onDate({ ...date, [key]: Number(e.target.value) || 0 })}
        className="h-9 w-full rounded-lg border px-2.5 text-sm font-semibold tabular-nums outline-none transition focus:ring-1"
        style={{ ...INSET_BOX, color: WOOD.text }}
      />
    </label>
  );

  const doReset = () => {
    try {
      window.localStorage.clear();
    } catch {
      /* storage unavailable */
    }
    setLocale(detectLocale());
    setConfirmReset(false);
    onReset();
  };

  if (!mounted) return null;

  return (
    // Anchored from the top (NOT re-centered): the header stays put no matter
    // how the content below grows or folds.
    <div className="fixed inset-0 z-40 flex justify-center overflow-hidden p-3 pt-[max(3vh,env(safe-area-inset-top))] sm:p-6 sm:pt-[7vh]">
      <div
        ref={backdropRef}
        className="absolute inset-0 opacity-0"
        style={{ background: "rgba(5,3,1,0.68)" }}
        onClick={() => onOpenChange(false)}
      />

      <div
        ref={panelRef}
        className="relative h-fit max-h-[86dvh] w-[min(94vw,470px)] overflow-hidden rounded-[26px] opacity-0"
        role="dialog"
        aria-modal="true"
        style={{
          background: `radial-gradient(circle at 46% 30%, ${WOOD.woodMid}, ${WOOD.woodDeep} 48%, ${WOOD.barkMid} 78%, ${WOOD.barkDark})`,
          boxShadow:
            "0 30px 80px rgba(0,0,0,0.65), inset 0 0 0 3px rgba(36,23,8,0.9), inset 0 0 0 6px rgba(58,39,18,0.9), inset 0 0 0 8px rgba(201,168,110,0.14), inset 0 26px 60px rgba(0,0,0,0.35)",
        }}
      >
        <TrunkRings
          size={520}
          seed={90210}
          rings={14}
          grain={false}
          className="pointer-events-none absolute left-1/2 top-1/2 h-[1150px] w-[1150px] -translate-x-1/2 -translate-y-1/2 opacity-[0.55]"
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(168deg, rgba(255,232,190,0.1), transparent 30%), radial-gradient(ellipse at 50% 44%, transparent 42%, rgba(12,6,1,0.5) 100%)",
            borderRadius: "inherit",
          }}
        />

        <div className="relative max-h-[86dvh] overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
          {/* Header */}
          <div data-menu-item className="mb-3 flex items-center justify-between">
            <div>
              <h2
                className="text-lg font-bold tracking-tight"
                style={{ color: WOOD.text, textShadow: "0 2px 4px rgba(0,0,0,0.6)" }}
              >
                {t("menu.title")}
              </h2>
              <p className="text-[10.5px]" style={{ color: WOOD.textDim }}>
                {t("menu.esc")}
              </p>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              aria-label={t("a11y.close")}
              className="grid h-9 w-9 place-items-center rounded-full border transition hover:brightness-125 active:scale-90"
              style={{
                background: `radial-gradient(circle at 40% 35%, ${WOOD.woodLight}, ${WOOD.woodDeep})`,
                borderColor: WOOD.barkMid,
                color: WOOD.text,
              }}
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div data-menu-item className="mb-4">
            <SlidingTabs<Tab>
              options={["settings", "credits"]}
              value={tab}
              onChange={setTab}
              render={(id) => t(("menu.tab." + id) as MsgKey)}
              thumbBackground={() => `linear-gradient(180deg, ${WOOD.ringLight}, ${WOOD.woodLight})`}
              size="text-[11.5px]"
            />
          </div>

          {tab === "settings" && (
            <div className="space-y-4">
              {/* 1 — Stars */}
              <div data-menu-item className="space-y-2">
                <SectionLabel>{t("hud.stars")}</SectionLabel>
                <div
                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5"
                  style={INSET_BOX}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ color: WOOD.accent }}>
                      <StarIcon className="h-4 w-4" />
                    </span>
                    <span className="tabular-nums text-lg font-bold" style={{ color: WOOD.text }}>
                      {stars.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10.5px] font-semibold tabular-nums"
                      style={{ color: WOOD.textDim }}
                    >
                      {lastSync
                        ? `${t("sync.synced")} ${relTime(Date.now() - lastSync)} · ${t("sync.next")} ${countdown(nextMs)}`
                        : t("sync.syncing")}
                    </span>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${starsLive ? "settings-pulse" : ""}`}
                      style={{ background: starsLive ? "#7ec85a" : "#6b7280" }}
                    />
                  </div>
                  {devControls && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onChangeStars(stars - 1)}
                        className="grid h-7 w-7 place-items-center rounded-md border transition hover:brightness-125"
                        style={{ borderColor: "rgba(201,168,110,0.3)", color: WOOD.text }}
                        aria-label={t("a11y.removeStar")}
                      >
                        <MinusIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => onChangeStars(stars + 1)}
                        className="grid h-7 w-7 place-items-center rounded-md border transition hover:brightness-125"
                        style={{ borderColor: "rgba(201,168,110,0.3)", color: WOOD.text }}
                        aria-label={t("a11y.addStar")}
                      >
                        <PlusIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                <div className="h-1 overflow-hidden rounded-full" style={{ background: "rgba(0,0,0,0.4)" }}>
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#7ec85a] via-[#9fd272] to-[#e6b25a] transition-[width] duration-500 ease-linear"
                    style={{ width: `${syncProgress}%` }}
                  />
                </div>
              </div>

              {/* 2 — Weather: auto/manual switch; manual unfolds its own panel */}
              <div data-menu-item className="space-y-2">
                <SectionLabel>{t("settings.weather")}</SectionLabel>
                <div
                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-[11px]"
                  style={{ ...INSET_BOX, color: WOOD.textDim }}
                >
                  <span className="font-semibold">Gossensass, Brenner</span>
                  <span className="flex items-center gap-2">
                    {weather
                      ? `${Math.round(weather.tempC)}°C · ${t(("sky." + weather.sky) as MsgKey)}`
                      : t("weather.loading")}
                    <span className="flex items-center gap-1 font-semibold">
                      <span style={{ color: WOOD.accent }}>
                        <WindIcon className="h-3.5 w-3.5" />
                      </span>
                      {weather ? `${Math.round(weather.windKmh)} km/h ${cardinal(weather.windDeg)}` : "--"}
                    </span>
                  </span>
                </div>
                <SlidingTabs<"live" | "manual">
                  options={["live", "manual"]}
                  value={mode}
                  onChange={onMode}
                  render={(m) => t(("mode." + m) as MsgKey)}
                  thumbBackground={() => "#9fd272"}
                  activeColor={() => "#0a100d"}
                />

                <div ref={unfoldRef} className="overflow-hidden" style={{ height: 0, opacity: 0, display: "none" }}>
                  <div
                    className="mt-1 space-y-3 rounded-xl border p-3"
                    style={{
                      borderColor: "rgba(201,168,110,0.22)",
                      background: "rgba(0,0,0,0.22)",
                      boxShadow: "inset 0 2px 8px rgba(0,0,0,0.4)",
                    }}
                  >
                    <div className="grid grid-cols-[0.75fr_0.75fr_1fr] gap-2">
                      {num("settings.day", "day", 1, 31, CalendarIcon)}
                      {num("settings.month", "month", 1, 12, CalendarIcon)}
                      {num("settings.year", "year", 1900, 2200, CalendarIcon)}
                    </div>
                    <div className="grid grid-cols-[0.82fr_1.18fr] items-end gap-2">
                      {num("settings.hour", "hour", 0, 23, ClockIcon)}
                      <div className="flex flex-col gap-1">
                        <span
                          className="text-[10px] font-medium uppercase tracking-[0.12em]"
                          style={{ color: WOOD.textDim }}
                        >
                          {t("settings.season")}
                        </span>
                        <span
                          className="flex h-9 items-center gap-2 rounded-lg border px-2.5 text-sm font-semibold capitalize"
                          style={{
                            color: seasonColor,
                            borderColor: seasonColor + "33",
                            background: seasonColor + "14",
                          }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: seasonColor }} />
                          {t(("season." + season) as MsgKey)}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span
                        className="text-[10px] font-medium uppercase tracking-[0.12em]"
                        style={{ color: WOOD.textDim }}
                      >
                        {t("settings.conditions")}
                      </span>
                      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                        {SKIES.map((s) => {
                          const active = manualSky === s;
                          const c = SKY_ACCENT[s];
                          const Icon = SKY_ICON[s];
                          return (
                            <button
                              key={s}
                              onClick={() => onSky(s)}
                              className="flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-semibold capitalize transition"
                              style={
                                active
                                  ? {
                                      color: c,
                                      borderColor: c + "77",
                                      background: c + "22",
                                      boxShadow: `inset 0 0 12px ${c}22`,
                                    }
                                  : { ...INSET_BOX, color: WOOD.textDim }
                              }
                            >
                              <Icon className="h-4 w-4" />
                              {t(("sky." + s) as MsgKey)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3 — Graphics */}
              <div data-menu-item className="space-y-2">
                <SectionLabel>
                  {t("settings.graphics")}
                  {graphicsQuality === "auto"
                    ? ` · ${t(("graphics." + resolvedGraphicsQuality) as MsgKey)}`
                    : ""}
                </SectionLabel>
                <SlidingTabs<GraphicsQuality>
                  options={GRAPHICS_OPTIONS}
                  value={graphicsQuality}
                  onChange={onGraphicsQuality}
                  render={(q) => t(("graphics." + q) as MsgKey)}
                  thumbBackground={(q) =>
                    q === "ultra"
                      ? "linear-gradient(180deg, #ffe6b0, #e0913a)"
                      : q === "extreme"
                        ? `linear-gradient(180deg, ${WOOD.accent}, #b8842f)`
                        : "rgba(240,226,200,0.92)"
                  }
                  inactiveColor={(q) =>
                    q === "ultra" || q === "extreme" ? WOOD.accent : WOOD.textDim
                  }
                  size="text-[10px]"
                />
                <label className="flex flex-col gap-1 pt-1.5">
                  <span
                    className="flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em]"
                    style={{ color: WOOD.textDim }}
                  >
                    {t("settings.fov")}
                    <span className="tabular-nums" style={{ color: WOOD.text }}>
                      {fov}°
                    </span>
                  </span>
                  <input
                    type="range"
                    min={MIN_FOV}
                    max={MAX_FOV}
                    step={1}
                    value={fov}
                    onChange={(e) => onFov(Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${WOOD.accent} ${
                        ((fov - MIN_FOV) / (MAX_FOV - MIN_FOV)) * 100
                      }%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.14) 100%)`,
                    }}
                  />
                </label>
                <div className="flex items-center justify-between gap-3 pt-1.5">
                  <span
                    className="text-[10px] font-medium uppercase tracking-[0.12em]"
                    style={{ color: WOOD.textDim }}
                  >
                    {t("settings.fps")}
                  </span>
                  <div className="w-40 shrink-0">
                    <SlidingTabs<"off" | "on">
                      options={["off", "on"]}
                      value={showFps ? "on" : "off"}
                      onChange={(v) => onShowFps(v === "on")}
                      render={(v) => t(v === "on" ? "settings.on" : "settings.off")}
                      thumbBackground={(v) => (v === "on" ? "#9fd272" : "rgba(240,226,200,0.92)")}
                      activeColor={() => "#0a100d"}
                      size="text-[10px]"
                    />
                  </div>
                </div>
              </div>

              {/* 4 — Language (custom dropdown) */}
              <div data-menu-item className="space-y-2">
                <SectionLabel>{t("menu.tab.language")}</SectionLabel>
                <LanguageSelect />
              </div>

              {/* 5 — Reset */}
              <div data-menu-item>
                {confirmReset ? (
                  <div
                    className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5"
                    style={{ borderColor: "rgba(224,110,90,0.45)", background: "rgba(90,25,12,0.35)" }}
                  >
                    <span className="text-[11px] font-bold" style={{ color: "#f0b0a0" }}>
                      {t("reset.confirm")}
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        onClick={doReset}
                        className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold"
                        style={{ background: "#e06e5a", color: "#1c0d08" }}
                      >
                        {t("reset.yes")}
                      </button>
                      <button
                        onClick={() => setConfirmReset(false)}
                        className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold"
                        style={{ color: WOOD.textDim }}
                      >
                        {t("reset.no")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmReset(true)}
                    title={t("reset.hint")}
                    className="w-full rounded-xl border py-2 text-[11px] font-bold transition hover:brightness-125"
                    style={{
                      borderColor: "rgba(224,110,90,0.4)",
                      color: "#e08a78",
                      background: "rgba(0,0,0,0.3)",
                    }}
                  >
                    {t("reset.button")}
                  </button>
                )}
              </div>
            </div>
          )}

          {tab === "credits" && (
            <div data-menu-item className="space-y-2">
              <p className="text-[11px]" style={{ color: WOOD.textDim }}>
                {t("credits.hint")}
              </p>
              {credits === null ? (
                <p className="text-[11px]" style={{ color: WOOD.textDim }}>
                  …
                </p>
              ) : credits.length === 0 ? (
                <p className="text-[11px]" style={{ color: WOOD.textDim }}>
                  {t("credits.empty")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {credits.map((cr, i) => (
                    <li key={i} className="rounded-xl border px-3 py-2" style={INSET_BOX}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[12px] font-bold" style={{ color: WOOD.text }}>
                          {cr.model}
                        </span>
                        {cr.source && (
                          <button
                            onClick={() => setConfirmLink(cr)}
                            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10.5px] font-bold transition hover:brightness-110 active:scale-95"
                            style={{
                              background: `linear-gradient(180deg, ${WOOD.accent}, #b8842f)`,
                              color: WOOD.barkDark,
                              boxShadow: "0 2px 5px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
                            }}
                          >
                            {t("credits.open")} <span aria-hidden>↗</span>
                          </button>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10.5px]" style={{ color: WOOD.textDim }}>
                        {cr.author}
                        {cr.author && cr.license && " · "}
                        {cr.license &&
                          (licenseUrl(cr.license) ? (
                            <button
                              onClick={() => setConfirmLink({ ...cr, source: licenseUrl(cr.license)! })}
                              className="underline decoration-dotted underline-offset-2 transition hover:brightness-125"
                            >
                              {cr.license}
                            </button>
                          ) : (
                            cr.license
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {confirmLink && (
          <ExternalLinkConfirm
            url={confirmLink.source}
            model={confirmLink.model}
            onClose={() => setConfirmLink(null)}
          />
        )}
      </div>

      <style jsx>{`
        .settings-pulse {
          animation: settings-pulse 2s ease-in-out infinite;
        }
        @keyframes settings-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(126, 200, 90, 0.5); }
          50% { box-shadow: 0 0 0 4px rgba(126, 200, 90, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .settings-pulse { animation: none; }
        }
        .menu-lang-list::-webkit-scrollbar {
          width: 8px;
        }
        .menu-lang-list::-webkit-scrollbar-thumb {
          background: rgba(201, 168, 110, 0.35);
          border-radius: 8px;
        }
        .menu-lang-list::-webkit-scrollbar-track {
          background: transparent;
        }
      `}</style>
    </div>
  );
}
