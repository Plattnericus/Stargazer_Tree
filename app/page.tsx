"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import SettingsMenu, { type ManualDate } from "@/components/SettingsMenu";
import Clock from "@/components/Clock";
import RotateControls from "@/components/RotateControls";
import {
  isGraphicsQuality,
  type GraphicsQuality,
  type ResolvedGraphicsQuality,
} from "@/lib/quality";
import { runGraphicsBenchmark } from "@/lib/benchmark";
import { I18nProvider, useI18n, type Locale, type MsgKey } from "@/lib/i18n";
import { useCoarsePointer } from "@/lib/useCoarsePointer";
import SearchBar from "@/components/SearchBar";
import HouseInterior from "@/components/HouseInterior";
import HouseFocusUI from "@/components/HouseFocusUI";
import GameHUD from "@/components/GameHUD";
import FpsCounter from "@/components/FpsCounter";
import RateLimitNotice from "@/components/RateLimitNotice";
import SoftwareRenderingNotice from "@/components/SoftwareRenderingNotice";
import MemorialSecret from "@/components/MemorialSecret";
import LoadingOverlay from "@/components/LoadingOverlay";
import { FlyIcon } from "@/components/Icons";
import { cameraBus, DEFAULT_FOV, MAX_FOV, MIN_FOV, type CamMode } from "@/lib/cameraBus";
import { nameForHouse, type Stargazer } from "@/lib/stargazers";
import { resolveTier, TIER_RANK } from "@/lib/rarity";
import { nowInZone } from "@/lib/astro";
import { GOSSENSASS } from "@/lib/location";
import { readStorage, writeStorage } from "@/lib/storage";
import { loadWalkPhysics } from "@/lib/walkPhysics";
import {
  manualWeather,
  sceneFromWeather,
  weatherFromApiPayload,
  type Sky,
  type Weather,
} from "@/lib/weather";

// Toggle the in-scene star editor via env (NEXT_PUBLIC_DEV_CONTROLS=true).
const DEV_CONTROLS = process.env.NEXT_PUBLIC_DEV_CONTROLS === "true";

const Experience = dynamic(() => import("@/components/Experience"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#0b1320]" />,
});

const STARGAZER_REFRESH_MS = 5 * 60 * 1000;
const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const LOADER_INTRO_MS = 900;
const GRAPHICS_STORAGE_KEY = "star-tree-graphics-quality";
const FOV_STORAGE_KEY = "star-tree-fov";
const FPS_STORAGE_KEY = "star-tree-show-fps";

function todayManualDate(): ManualDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: 13 };
}

// The poll returns a fresh array every time. Keep the previous one when the
// content is identical so the scene doesn't rebuild houses, bridges and
// lanterns every five minutes for nothing.
function sameStargazers(a: Stargazer[] | null, b: Stargazer[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function prefetchWalk() {
  loadWalkPhysics().catch(() => {
    /* retried when walk mode is actually opened */
  });
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

// Camera-mode labels, one entry per supported locale (typed `satisfies` so a
// missing translation fails the build instead of silently falling back).
const MODE_LABELS = {
  de: { orbit: "Ansicht", fly: "Fliegen", walk: "Gehen" },
  en: { orbit: "Orbit", fly: "Fly", walk: "Walk" },
  it: { orbit: "Vista", fly: "Vola", walk: "Cammina" },
  es: { orbit: "Vista", fly: "Volar", walk: "Andar" },
  fr: { orbit: "Vue", fly: "Voler", walk: "Marcher" },
  pt: { orbit: "Vista", fly: "Voar", walk: "Andar" },
  nl: { orbit: "Weergave", fly: "Vliegen", walk: "Lopen" },
  pl: { orbit: "Widok", fly: "Lot", walk: "Chodzenie" },
  ru: { orbit: "Обзор", fly: "Полёт", walk: "Ходьба" },
  tr: { orbit: "Görünüm", fly: "Uçuş", walk: "Yürüyüş" },
  zh: { orbit: "环视", fly: "飞行", walk: "行走" },
  ja: { orbit: "周回", fly: "飛行", walk: "歩行" },
  ko: { orbit: "궤도", fly: "비행", walk: "걷기" },
  hi: { orbit: "परिक्रमा", fly: "उड़ान", walk: "चलना" },
  ar: { orbit: "مدار", fly: "طيران", walk: "مشي" },
} satisfies Record<Locale, Record<"orbit" | "fly" | "walk", string>>;

function OrbitIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="9" ry="4.2" />
    </svg>
  );
}

// DOM overlay for the walk-mode intro: black while the physics module loads
// (the scene remounts behind it once), then a fade from black and letterbox
// bars for as long as WalkControls reports the intro running.
function IntroOverlay({ active, loading }: { active: boolean; loading: boolean }) {
  const [flash, setFlash] = useState(active);
  useEffect(() => {
    if (!active) return;
    setFlash(true);
    const id = window.setTimeout(() => setFlash(false), 550);
    return () => window.clearTimeout(id);
  }, [active]);

  if (!active && !flash && !loading) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div
        className="absolute inset-0 bg-black transition-opacity duration-500 ease-out"
        style={{ opacity: flash || loading ? 1 : 0 }}
      />
      <div
        className={`absolute inset-x-0 top-0 bg-black transition-all duration-700 ease-out ${
          active ? "h-[8vh] opacity-100" : "h-0 opacity-0"
        }`}
      />
      <div
        className={`absolute inset-x-0 bottom-0 bg-black transition-all duration-700 ease-out ${
          active ? "h-[8vh] opacity-100" : "h-0 opacity-0"
        }`}
      />
    </div>
  );
}

function WalkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13" cy="4.4" r="1.7" fill="currentColor" stroke="none" />
      <path d="M12.5 8l-2 4 2 1.8 1 5.2" />
      <path d="M12.5 8l3 2.2 3-1" />
      <path d="M10.5 12l-3.2 1-1 4" />
    </svg>
  );
}

const LOADING_TIPS: MsgKey[] = ["load.tip1", "load.tip2", "load.tip3", "load.tip4"];

// Cycles through a short flavor-tip line every 3s with a clean GSAP
// cross-fade — shown under the quality-switch spinner so a longer switch
// doesn't just sit on one static line the whole time.
function RotatingTip() {
  const { t } = useI18n();
  const [tipIndex, setTipIndex] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setTipIndex((i) => (i + 1) % LOADING_TIPS.length);
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.fromTo(
      el,
      { autoAlpha: 0, y: 5 },
      { autoAlpha: 1, y: 0, duration: reduced ? 0 : 0.4, ease: "power2.out" },
    );
  }, [tipIndex]);

  return (
    <span ref={ref} className="text-[11px] text-white/50">
      {t(LOADING_TIPS[tipIndex])}
    </span>
  );
}

export default function Page() {
  return (
    <I18nProvider>
      <Home />
    </I18nProvider>
  );
}

function Home() {
  const { t, locale } = useI18n();
  const coarse = useCoarsePointer();
  const [stars, setStars] = useState(0);
  const [starsLive, setStarsLive] = useState(false);
  const [stargazers, setStargazers] = useState<Stargazer[] | null>(null);
  // When the stargazer feed was last successfully pulled — surfaced quietly in
  // the settings panel so you can tell how fresh the village is.
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [nextSync, setNextSync] = useState<number | null>(null);
  // Set only when the last stargazer fetch actually hit GitHub's rate limit
  // (not just "no data yet") — surfaced as a small dismissible HUD notice.
  const [rateLimited, setRateLimited] = useState(false);
  const [starsReady, setStarsReady] = useState(false);
  const [weatherReady, setWeatherReady] = useState(false);

  // Weather: live reading from Gossensass / Brenner, plus a manual override mode.
  const [liveWeather, setLiveWeather] = useState<Weather | null>(null);
  const [mode, setMode] = useState<"live" | "manual">("live");
  const [manualSky, setManualSky] = useState<Sky>("clear");
  const [search, setSearch] = useState("");
  const [searchActive, setSearchActive] = useState(-1);
  const [camMode, setCamMode] = useState<CamMode>("orbit");
  const flying = camMode !== "orbit";
  // Walk mode's cinematic intro, lifted out of the Canvas so the overlay and
  // HUD can react to it. `walkStarted` flips once WalkControls is running,
  // i.e. the physics module has loaded.
  const [introing, setIntroing] = useState(false);
  const [walkStarted, setWalkStarted] = useState(false);
  useEffect(() => {
    if (camMode === "walk") return;
    setIntroing(false);
    setWalkStarted(false);
  }, [camMode]);
  const handleIntroChange = useCallback((running: boolean) => {
    setIntroing(running);
    if (running) setWalkStarted(true);
  }, []);
  const walkIntroing = camMode === "walk" && introing;
  const walkLoading = camMode === "walk" && !walkStarted;
  const [focusedHouse, setFocusedHouse] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  // Let the loader draw first; mount WebGL only after live data is ready.
  const [loaderIntroDone, setLoaderIntroDone] = useState(false);
  const [mountScene, setMountScene] = useState(false);
  const [graphicsQuality, setGraphicsQuality] = useState<GraphicsQuality>("auto");
  // False until the saved quality has been read, so a stored manual choice
  // never kicks off the auto benchmark first.
  const [graphicsLoaded, setGraphicsLoaded] = useState(false);
  const [resolvedGraphicsQuality, setResolvedGraphicsQuality] =
    useState<ResolvedGraphicsQuality>("medium");
  const [autoTierReady, setAutoTierReady] = useState(false);
  const [fov, setFov] = useState(DEFAULT_FOV);
  const handleFov = (n: number) => {
    setFov(n);
    cameraBus.baseFov = n;
    writeStorage(FOV_STORAGE_KEY, String(n));
  };
  const [showFps, setShowFps] = useState(false);
  const handleShowFps = (on: boolean) => {
    setShowFps(on);
    writeStorage(FPS_STORAGE_KEY, on ? "1" : "0");
  };
  const [date, setDate] = useState<ManualDate>(todayManualDate);

  useEffect(() => {
    const id = window.setTimeout(() => setLoaderIntroDone(true), LOADER_INTRO_MS);
    return () => window.clearTimeout(id);
  }, []);

  // One Escape order for the whole HUD, topmost layer first: memorial → menu →
  // info → house panel → focus → open the menu. Fly/walk are excluded, there
  // Esc releases the pointer lock.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isTextInputTarget(event.target) || flying) return;
      event.preventDefault();
      if (secretOpen) {
        setSecretOpen(false);
        return;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return;
      }
      if (infoOpen) {
        setInfoOpen(false);
        return;
      }
      if (selected !== null) {
        setSelected(null);
        return;
      }
      if (focusedHouse !== null) {
        setFocusedHouse(null);
        setSearchActive(-1);
        return;
      }
      setMenuOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flying, focusedHouse, infoOpen, menuOpen, secretOpen, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "i" || isTextInputTarget(event.target) || flying) return;
      if (focusedHouse === null || selected !== null || secretOpen || menuOpen) return;
      event.preventDefault();
      setInfoOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flying, focusedHouse, menuOpen, secretOpen, selected]);

  // "O" opens the in-app profile preview for the focused house (same action
  // as the Profil button) — a keyboard shortcut alongside "I" for info.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "o" || isTextInputTarget(event.target) || flying) return;
      if (focusedHouse === null || selected !== null || secretOpen || menuOpen) return;
      event.preventDefault();
      setInfoOpen(false);
      setSelected(focusedHouse);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flying, focusedHouse, menuOpen, secretOpen, selected]);

  useEffect(() => {
    const saved = readStorage(GRAPHICS_STORAGE_KEY);
    if (isGraphicsQuality(saved)) setGraphicsQuality(saved);
    setGraphicsLoaded(true);
  }, []);

  useEffect(() => {
    const saved = Number(readStorage(FOV_STORAGE_KEY));
    const n = Number.isFinite(saved) && saved >= MIN_FOV && saved <= MAX_FOV ? saved : DEFAULT_FOV;
    setFov(n);
    cameraBus.baseFov = n;
  }, []);

  useEffect(() => {
    setShowFps(readStorage(FPS_STORAGE_KEY) === "1");
  }, []);

  // QA override: ?hour=21&sky=storm&day=3&month=7 forces manual weather so any
  // time/condition can be checked from the URL (used by visual tests too).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const hour = q.get("hour");
    const sky = q.get("sky");
    const day = q.get("day");
    const month = q.get("month");
    if (hour === null && sky === null) return;
    setMode("manual");
    setDate((d) => ({
      ...d,
      hour: hour !== null ? Math.min(23, Math.max(0, Number(hour) || 0)) : d.hour,
      day: day !== null ? Math.min(31, Math.max(1, Number(day) || d.day)) : d.day,
      month: month !== null ? Math.min(12, Math.max(1, Number(month) || d.month)) : d.month,
    }));
    if (sky && ["clear", "clouds", "fog", "rain", "snow", "storm"].includes(sky)) {
      setManualSky(sky as Sky);
    }
  }, []);

  useEffect(() => {
    if (!graphicsLoaded) return;
    writeStorage(GRAPHICS_STORAGE_KEY, graphicsQuality);
    if (graphicsQuality !== "auto") {
      setResolvedGraphicsQuality(graphicsQuality);
      setAutoTierReady(true);
      return;
    }
    // Short GPU probe (see lib/benchmark.ts). Runs in parallel with the data
    // fetches, finishes well within the loader's minimum visible time and
    // always resolves.
    let cancelled = false;
    runGraphicsBenchmark().then((tier) => {
      if (cancelled) return;
      setResolvedGraphicsQuality(tier);
      setAutoTierReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [graphicsLoaded, graphicsQuality]);

  const initialDataReady = starsReady && weatherReady;

  useEffect(() => {
    if (loaderIntroDone && initialDataReady && autoTierReady) setMountScene(true);
  }, [initialDataReady, loaderIntroDone, autoTierReady]);

  // The Canvas remounts on quality-tier change (`key={graphicsQuality}` in
  // Experience.tsx — a full shader/asset recompile). Show a small "switching
  // quality" overlay for that remount instead of a stutter — the fancy
  // one-shot LoadingOverlay below locks itself hidden after the first reveal
  // (its `revealed` ref), so it deliberately never comes back on its own.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  useEffect(() => {
    if (sceneReady) setHasLoadedOnce(true);
  }, [sceneReady]);
  const prevResolvedQuality = useRef(resolvedGraphicsQuality);
  useEffect(() => {
    if (prevResolvedQuality.current !== resolvedGraphicsQuality) {
      prevResolvedQuality.current = resolvedGraphicsQuality;
      setSceneReady(false);
    }
  }, [resolvedGraphicsQuality]);
  const switchingQuality = hasLoadedOnce && !sceneReady;

  useEffect(() => {
    // Stargazers refresh every 5 minutes so new stars grow the tree live,
    // weather every 10. Hidden tabs skip their turn and catch up when shown.
    // `no-store` keeps the browser from reusing an old response on startup.
    const lastLoad = { stars: 0, weather: 0 };
    const loadStars = () => {
      lastLoad.stars = Date.now();
      return fetch("/api/stargazers", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (typeof d.stars === "number") setStars(d.stars);
          setStarsLive(Boolean(d.live));
          const next: Stargazer[] | null = Array.isArray(d.stargazers) ? d.stargazers : null;
          setStargazers((prev) => (sameStargazers(prev, next) ? prev : next));
          const syncedAt = typeof d.fetchedAt === "number" ? d.fetchedAt : Date.now();
          setLastSync(syncedAt);
          setNextSync(Date.now() + STARGAZER_REFRESH_MS);
          setRateLimited(Boolean(d.rateLimited));
          setStarsReady(true);
        })
        .catch(() => {
          setStarsReady(true);
        });
    };

    const loadWeather = () => {
      lastLoad.weather = Date.now();
      return fetch("/api/weather")
        .then((r) => r.json())
        .then((d) => {
          setLiveWeather(weatherFromApiPayload(d));
          setWeatherReady(true);
        })
        .catch(() => {
          setLiveWeather(manualWeather(13, new Date().getMonth(), "clouds"));
          setWeatherReady(true);
        });
    };

    loadStars();
    loadWeather();
    const starId = setInterval(() => {
      if (!document.hidden) loadStars();
    }, STARGAZER_REFRESH_MS);
    const weatherId = setInterval(() => {
      if (!document.hidden) loadWeather();
    }, WEATHER_REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastLoad.stars >= STARGAZER_REFRESH_MS) loadStars();
      if (now - lastLoad.weather >= WEATHER_REFRESH_MS) loadWeather();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(starId);
      clearInterval(weatherId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // The sun/moon follow the real clock: bump once a minute so live mode keeps
  // moving between the 10-minute weather refreshes.
  const [timeTick, setTimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTimeTick((t) => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const weather: Weather | null = useMemo(() => {
    if (mode === "manual") {
      return manualWeather(
        date.hour,
        Math.min(11, Math.max(0, date.month - 1)),
        manualSky,
        date.year,
        date.day,
      );
    }
    if (!liveWeather) return null;
    const local = nowInZone(GOSSENSASS.tz);
    return {
      ...liveWeather,
      year: local.year,
      month: local.month,
      day: local.day,
      hour: local.hour,
      minute: local.minute,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeTick re-reads the wall clock
  }, [mode, date, manualSky, liveWeather, timeTick]);

  const params = useMemo(
    () =>
      sceneFromWeather(
        weather ?? manualWeather(13, new Date().getMonth(), "clouds"),
      ),
    [weather],
  );

  // Dev-only introspection for the headless visual tests.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __sceneParams?: unknown }).__sceneParams = params;
    }
  }, [params]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    const count = Math.max(0, Math.floor(stars));
    const all = Array.from({ length: count }, (_, i) => {
      const gazer = stargazers?.[i] ?? null;
      return {
        index: i,
        name: nameForHouse(i, stargazers),
        tier: resolveTier(i, stargazers),
        contributor: Boolean(gazer?.contributor),
      };
    });
    const filtered = q
      ? all.filter((result) => result.name.toLowerCase().includes(q))
      : all;
    // Sort by rarity — legendary first, then rare/uncommon/common — with star
    // order (index) breaking ties so the list stays stable.
    return filtered.sort(
      (a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.index - b.index,
    );
  }, [search, stargazers, stars]);

  useEffect(() => {
    if (searchResults.length === 0) {
      setSearchActive(-1);
      return;
    }
    if (
      searchActive >= 0 &&
      !searchResults.some((result) => result.index === searchActive)
    ) {
      setSearchActive(searchResults[0].index);
    }
  }, [searchActive, searchResults]);

  useEffect(() => {
    const activeCount = Math.max(0, Math.floor(stars));
    if (focusedHouse !== null && focusedHouse >= activeCount) {
      setFocusedHouse(null);
      setInfoOpen(false);
      setSearchActive(-1);
    }
    if (selected !== null && selected >= activeCount) setSelected(null);
  }, [focusedHouse, selected, stars]);

  const handleHouseClick = (index: number) => {
    setSearchActive(index);
    if (focusedHouse === index) {
      setInfoOpen(false);
      setSelected(index);
      return;
    }
    setFocusedHouse(index);
    setInfoOpen(false);
    setSelected(null);
  };

  const highlight = focusedHouse ?? searchActive;
  const modeLabels = MODE_LABELS[locale];
  const overlayOpen = menuOpen || selected !== null || secretOpen || infoOpen;

  return (
    <main className="relative h-full w-full overflow-hidden">
      <div
        className={`absolute inset-0 transition duration-1000 ease-out ${
          sceneReady ? "scale-100 opacity-100 blur-0" : "scale-[1.015] opacity-0 blur-[2px]"
        }`}
      >
        {mountScene && (
          <Experience
            stars={stars}
            params={params}
            highlight={highlight}
            focusedHouse={focusedHouse}
            camMode={camMode}
            stargazers={stargazers}
            graphicsQuality={resolvedGraphicsQuality}
            uiOverlayOpen={overlayOpen}
            showStats={showFps}
            onSelectHouse={handleHouseClick}
            onFindDove={() => setSecretOpen(true)}
            onReady={() => setSceneReady(true)}
            onIntroChange={handleIntroChange}
          />
        )}
      </div>
      <IntroOverlay active={walkIntroing} loading={walkLoading} />
      {switchingQuality && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-[#0b1320]/72 backdrop-blur-sm transition-opacity duration-300">
          <div className="flex flex-col items-center gap-3 text-white/85">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/85" />
            <span className="text-xs font-medium uppercase tracking-[0.14em]">
              {t("load.quality")}
            </span>
            <RotatingTip />
          </div>
        </div>
      )}
      <LoadingOverlay
        sceneReady={sceneReady}
        dataReady={initialDataReady}
        starsReady={starsReady}
        weatherReady={weatherReady}
      />
      {secretOpen && <MemorialSecret onClose={() => setSecretOpen(false)} />}
      {showFps && sceneReady && <FpsCounter quality={resolvedGraphicsQuality} />}

      <div
        className={`transition duration-700 ease-out ${
          sceneReady ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <SearchBar
          query={search}
          onQuery={setSearch}
          results={searchResults}
          activeIndex={highlight}
          onActive={setSearchActive}
          onSelect={(result) => {
            // Picking a search result FOCUSES the house (camera flies + focus
            // card) — it does NOT open GitHub. The house click opens the profile.
            setSearch(result.name);
            setSearchActive(result.index);
            setFocusedHouse(result.index);
            setInfoOpen(false);
            setSelected(null);
          }}
        />

        {/* Camera mode: orbit view · free fly · first-person walk. Fly/walk are
            pointer-lock + WASD, so this switch is desktop-only. */}
        {!coarse && (
          <div className="anim-rise-x absolute bottom-[calc(5rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-[#0b100d]/72 p-1 shadow-xl shadow-black/40 backdrop-blur-sm sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {(["orbit", "fly", "walk"] as const).map((m) => {
              const active = camMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setCamMode(m);
                    // Fullscreen and pointer lock need a direct user gesture,
                    // so they're requested here rather than in an effect.
                    // Pointer lock waits for fullscreen to resolve: requesting
                    // both at once throws WrongDocumentError in Chrome.
                    if (m === "orbit") {
                      if (document.fullscreenElement) {
                        document.exitFullscreen?.().catch(() => {});
                      }
                      return;
                    }
                    // requestPointerLock() rejects its promise in current
                    // Chrome and throws synchronously in older browsers.
                    const lock = () => {
                      try {
                        const result = document.querySelector("canvas")?.requestPointerLock?.();
                        (result as unknown as Promise<void> | undefined)?.catch?.(() => {});
                      } catch {
                        /* environment doesn't support it — fine, orbit still works */
                      }
                    };
                    if (document.fullscreenElement) {
                      lock();
                    } else {
                      document.documentElement.requestFullscreen?.().then(lock).catch(lock);
                    }
                  }}
                  // Start fetching the physics chunk as soon as walk mode
                  // looks likely, so the click has little left to wait for.
                  onPointerEnter={m === "walk" ? prefetchWalk : undefined}
                  onFocus={m === "walk" ? prefetchWalk : undefined}
                  aria-label={modeLabels[m]}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition active:scale-95 ${
                    active
                      ? "bg-white/15 text-white shadow-inner shadow-white/10"
                      : "text-white/55 hover:text-white"
                  }`}
                >
                  {m === "orbit" ? (
                    <OrbitIcon className="h-3.5 w-3.5" />
                  ) : m === "fly" ? (
                    <FlyIcon className="h-3.5 w-3.5" />
                  ) : (
                    <WalkIcon className="h-3.5 w-3.5" />
                  )}
                  <span className="hidden sm:inline">{modeLabels[m]}</span>
                </button>
              );
            })}
          </div>
        )}
        {flying && !coarse && !walkIntroing && !walkLoading && (
          <GameHUD mode={camMode === "walk" ? "walk" : "fly"} />
        )}
        <div className="pointer-events-none absolute left-[calc(1.25rem+env(safe-area-inset-left))] top-[calc(1.25rem+env(safe-area-inset-top))] z-30 flex flex-col items-start gap-2">
          <SoftwareRenderingNotice />
          <RateLimitNotice active={rateLimited} />
        </div>

        {selected !== null && (
          <HouseInterior
            index={selected}
            stargazer={stargazers?.[selected] ?? null}
            onClose={() => setSelected(null)}
          />
        )}
        {focusedHouse !== null && selected === null && !secretOpen && !menuOpen && (
          <HouseFocusUI
            index={focusedHouse}
            stargazer={stargazers?.[focusedHouse] ?? null}
            stargazers={stargazers}
            infoOpen={infoOpen}
            onOpenInfo={() => setInfoOpen(true)}
            onCloseInfo={() => setInfoOpen(false)}
            onOpenProfile={() => {
              setInfoOpen(false);
              setSelected(focusedHouse);
            }}
            onClearFocus={() => {
              setInfoOpen(false);
              setFocusedHouse(null);
              setSearchActive(-1);
            }}
          />
        )}
        <Clock
          mode={mode}
          manualHour={date.hour}
          sunrise={liveWeather?.sunrise}
          sunset={liveWeather?.sunset}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <RotateControls fly={flying} />
        <SettingsMenu
          weather={weather}
          mode={mode}
          date={date}
          manualSky={manualSky}
          stars={stars}
          devControls={DEV_CONTROLS}
          onChangeStars={(n) => setStars(Math.max(0, n))}
          starsLive={starsLive}
          lastSync={lastSync}
          nextSync={nextSync}
          graphicsQuality={graphicsQuality}
          resolvedGraphicsQuality={resolvedGraphicsQuality}
          fov={fov}
          showFps={showFps}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onMode={setMode}
          onDate={setDate}
          onSky={setManualSky}
          onGraphicsQuality={setGraphicsQuality}
          onFov={handleFov}
          onShowFps={handleShowFps}
          onReset={() => {
            setGraphicsQuality("auto");
            handleFov(DEFAULT_FOV);
            handleShowFps(false);
            setMode("live");
            setManualSky("clear");
            setDate(todayManualDate());
            setMenuOpen(false);
          }}
        />
      </div>

      {/* Filmic finish: soft anamorphic-style vignette. Keep this as a simple
          gradient; full-screen blend/noise layers force costly compositing over
          WebGL while the camera moves. */}
      <div
        className="pointer-events-none absolute inset-0 z-[8]"
        style={{
          background: `radial-gradient(ellipse at center, transparent ${
            resolvedGraphicsQuality === "extreme" ? "56%" : "62%"
          }, rgba(4,2,0,${resolvedGraphicsQuality === "extreme" ? 0.3 : 0.2}) 100%)`,
        }}
      />
    </main>
  );
}
