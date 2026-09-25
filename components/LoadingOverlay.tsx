"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useProgress } from "@react-three/drei";
import gsap from "gsap";
import { useI18n } from "@/lib/i18n";

const MIN_VISIBLE_MS = 900;
const INSTANT_CACHE_GRACE_MS = 1800;

type LoaderStyle = CSSProperties & {
  "--load": string;
};

type Branch = { d: string; w: number; delay: number };
type Leaf = { cx: number; cy: number; r: number; c: string; d: number };

const LEAF_COLORS = ["#6fab4e", "#7fb75a", "#9fd272", "#cbe98c", "#d7a756", "#e8f6a5"];

// Seeded line-art tree used by the loading screen.
function buildTree(): { branches: Branch[]; leaves: Leaf[] } {
  let seed = 1337;
  const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const branches: Branch[] = [];
  const leaves: Leaf[] = [];
  const MAX_DEPTH = 5;
  const STROKE = 0.34; // seconds per branch stroke
  // Round coordinates to avoid hydration drift between runtimes.
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;

  const grow = (
    x: number,
    y: number,
    angle: number,
    len: number,
    depth: number,
    delay: number,
  ) => {
    if (branches.length > 70) return;
    const x2 = r2(x + Math.sin(angle) * len);
    const y2 = r2(y - Math.cos(angle) * len);
    // Add a slight bend so branches do not look mechanical.
    const mx = r2((x + x2) / 2 + Math.cos(angle) * (rng() - 0.5) * len * 0.5);
    const my = r2((y + y2) / 2 + Math.sin(angle) * (rng() - 0.5) * len * 0.5);
    branches.push({
      d: `M${x.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      w: r2(Math.max(0.8, 4 - depth * 0.72)),
      delay: r3(delay),
    });

    const done = delay + STROKE;
    if (depth >= MAX_DEPTH) {
      leaves.push({
        cx: r2(x2),
        cy: r2(y2),
        r: r2(2.8 + rng() * 2.2),
        c: LEAF_COLORS[Math.floor(rng() * LEAF_COLORS.length)],
        d: r3(done + 0.1),
      });
      return;
    }
    const kids = depth === 0 ? 2 : rng() < 0.32 ? 3 : 2;
    const spread = 0.42 + rng() * 0.22;
    for (let i = 0; i < kids; i++) {
      const f = i / (kids - 1) - 0.5;
      const childAngle = angle + f * spread * 2 + (rng() - 0.5) * 0.18;
      grow(x2, y2, childAngle, len * (0.7 + rng() * 0.08), depth + 1, done + rng() * 0.04);
      // Add a few leaves along upper branches.
      if (depth >= MAX_DEPTH - 2 && rng() < 0.5) {
        leaves.push({
          cx: r2(x2),
          cy: r2(y2),
          r: r2(2.4 + rng() * 1.8),
          c: LEAF_COLORS[Math.floor(rng() * LEAF_COLORS.length)],
          d: r3(done + 0.1),
        });
      }
    }
  };

  grow(100, 202, 0, 34, 0, 0);
  return { branches, leaves };
}

const TREE = buildTree();

export default function LoadingOverlay({
  sceneReady,
  dataReady,
  starsReady,
  weatherReady,
}: {
  sceneReady: boolean;
  dataReady: boolean;
  starsReady: boolean;
  weatherReady: boolean;
}) {
  const { t } = useI18n();
  const { progress, active, loaded, total, item } = useProgress();
  const [hidden, setHidden] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [settled, setSettled] = useState(false);
  const [cacheGraceDone, setCacheGraceDone] = useState(false);
  const [sceneGraceDone, setSceneGraceDone] = useState(false);
  const [idleProgress, setIdleProgress] = useState(12);
  const [displayProgress, setDisplayProgress] = useState(0);
  const displayRef = useRef({ value: 0 });
  const progressTween = useRef<gsap.core.Tween | null>(null);
  const sawLoad = useRef(false);
  const revealed = useRef(false);

  if (active || progress > 0) sawLoad.current = true;

  useEffect(() => {
    const settledId = window.setTimeout(() => setSettled(true), MIN_VISIBLE_MS);
    const cacheId = window.setTimeout(() => setCacheGraceDone(true), INSTANT_CACHE_GRACE_MS);
    return () => {
      window.clearTimeout(settledId);
      window.clearTimeout(cacheId);
    };
  }, []);

  useEffect(() => {
    if (!sceneReady) return;
    const id = window.setTimeout(() => setSceneGraceDone(true), 650);
    return () => window.clearTimeout(id);
  }, [sceneReady]);

  const idleStart = useRef(0);
  useEffect(() => {
    // The overlay stays mounted after it hides, so stop ticking once it exits.
    if (exiting) return;
    if (!idleStart.current) idleStart.current = performance.now();
    const id = window.setInterval(() => {
      const seconds = (performance.now() - idleStart.current) / 1000;
      const softProgress = 12 + Math.log1p(seconds * 1.15) * 18;
      setIdleProgress(Math.min(92, softProgress));
    }, 180);
    return () => window.clearInterval(id);
  }, [exiting]);

  const targetProgress = useMemo(() => {
    if (sceneReady && sceneGraceDone && dataReady) return 100;
    if (!dataReady) return Math.min(42, Math.max(12, idleProgress * 0.48));

    const assetProgress = sawLoad.current ? progress : cacheGraceDone ? 18 : 0;
    const mappedAssets = 44 + assetProgress * 0.48;
    return Math.min(96, Math.max(mappedAssets, idleProgress));
  }, [cacheGraceDone, dataReady, idleProgress, progress, sceneGraceDone, sceneReady]);

  useEffect(() => {
    progressTween.current?.kill();
    const current = displayRef.current.value;
    const distance = Math.abs(targetProgress - current);
    progressTween.current = gsap.to(displayRef.current, {
      value: targetProgress,
      duration: Math.max(0.32, Math.min(1.2, distance / 52)),
      ease: "none",
      overwrite: true,
      onUpdate: () => setDisplayProgress(displayRef.current.value),
    });
    return () => {
      progressTween.current?.kill();
    };
  }, [targetProgress]);

  const ready =
    dataReady &&
    sceneReady &&
    settled &&
    ((!active &&
      ((sawLoad.current && progress >= 99) || (!sawLoad.current && cacheGraceDone))) ||
      sceneGraceDone);

  useEffect(() => {
    if (!ready || revealed.current) return;
    revealed.current = true;
    progressTween.current?.kill();
    displayRef.current.value = 100;
    setDisplayProgress(100);
    setExiting(true);
    const id = window.setTimeout(() => setHidden(true), 920);
    return () => window.clearTimeout(id);
  }, [ready]);

  if (hidden) return null;

  const style: LoaderStyle = {
    "--load": `${Math.min(1, displayProgress / 100)}`,
  };

  const loadedAssets = total > 0 ? Math.min(loaded, total) : 0;
  const assetCount = total > 0 ? ` (${loadedAssets} / ${total})` : "";
  const phase = (() => {
    if (!starsReady) return t("load.stargazers");
    if (!weatherReady) return t("load.weather");
    if (displayProgress < 52) return t("load.assets");
    if (displayProgress < 76) return t("load.models");
    if (displayProgress < 92) return t("load.scene");
    if (displayProgress < 96) return t("load.renderer");
    return t("load.opening");
  })();
  const status = `${phase}${assetCount}`;
  const itemName = item?.split("/").pop()?.replace(/\?.*$/, "");
  const detail =
    total > 0
      ? itemName
        ? t("load.assetDetail", { n: loadedAssets, total, item: itemName })
        : t("load.assetsDetail", { n: loadedAssets, total })
      : !starsReady
        ? t("load.village")
        : !weatherReady
          ? t("load.mountain")
          : t("load.preparing");

  // Strokes draw outward, then leaves bloom at the tips.
  const { branches, leaves } = TREE;

  return (
    <div
      className={`loader-root fixed inset-0 z-50 grid place-items-center overflow-hidden ${
        exiting ? "loader-exit" : ""
      }`}
      style={style}
    >
      <div className="loader-glow" />

      <div className="loader-stage" aria-label={t("load.aria")}>
        <div className="loader-mark">
          <svg viewBox="0 0 200 210" className="loader-svg" aria-hidden="true">
            <defs>
              <linearGradient id="loaderBark" x1="100" y1="200" x2="100" y2="100"
                gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#8a6a3e" />
                <stop offset="0.55" stopColor="#6f9a4d" />
                <stop offset="1" stopColor="#cbe98c" />
              </linearGradient>
            </defs>

            <g className="loader-canopy">
              {branches.map((b, i) => (
                <path
                  key={i}
                  className="loader-branch"
                  d={b.d}
                  pathLength={1}
                  strokeWidth={b.w}
                  style={{ animationDelay: `${b.delay}s` }}
                />
              ))}
              {leaves.map((l, i) => (
                <circle
                  key={i}
                  className="loader-leaf"
                  cx={l.cx}
                  cy={l.cy}
                  r={l.r}
                  fill={l.c}
                  style={{ animationDelay: `${l.d}s` }}
                />
              ))}
            </g>

            <line className="loader-ground" x1="56" y1="200" x2="144" y2="200" />
          </svg>
        </div>

        <div className="loader-copy">
          <div className="loader-title">Star Tree</div>
          <div className="loader-status" key={phase}>
            <span>{status}</span>
            <span className="loader-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
          <div className="loader-detail">{detail}</div>
        </div>

        <div className="loader-meter">
          <div className="loader-meter-fill" />
        </div>
        <div className="loader-percent">{Math.round(displayProgress)}%</div>
      </div>

      <style jsx>{`
        .loader-root {
          background:
            radial-gradient(100% 70% at 50% 30%, rgba(120, 159, 88, 0.08), transparent 62%),
            linear-gradient(180deg, #0b110e 0%, #090d0b 55%, #070908 100%);
          color: white;
          opacity: 1;
          transform: scale(1);
          transition: opacity 820ms cubic-bezier(0.22, 1, 0.36, 1),
            transform 820ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        .loader-exit {
          opacity: 0;
          transform: scale(1.02);
          pointer-events: none;
        }

        /* Soft glow behind the tree mark. */
        .loader-glow {
          position: absolute;
          top: 38%;
          left: 50%;
          width: 460px;
          height: 460px;
          max-width: 88vw;
          max-height: 88vw;
          transform: translate(-50%, -50%);
          border-radius: 999px;
          pointer-events: none;
          background: radial-gradient(
            circle,
            rgba(159, 210, 114, 0.1),
            rgba(159, 210, 114, 0.03) 42%,
            transparent 70%
          );
          animation: loader-breathe 6s ease-in-out infinite;
        }

        .loader-stage {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 22px;
          animation: loader-enter 800ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }

        .loader-mark {
          position: relative;
          width: 196px;
          height: 206px;
          display: grid;
          place-items: center;
        }

        .loader-svg {
          width: 196px;
          height: 206px;
          overflow: visible;
          filter: drop-shadow(0 18px 38px rgba(0, 0, 0, 0.4));
        }

        /* Subtle idle sway from the trunk base. */
        .loader-canopy {
          transform-box: fill-box;
          transform-origin: 100px 198px;
          animation: loader-sway 6s ease-in-out infinite;
        }

        .loader-branch {
          fill: none;
          stroke: url(#loaderBark);
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-dasharray: 1;
          stroke-dashoffset: 1;
          animation: loader-draw 1.05s cubic-bezier(0.65, 0, 0.35, 1) forwards;
        }

        .loader-leaf {
          transform-box: fill-box;
          transform-origin: center;
          transform: scale(0);
          opacity: 0;
          animation: loader-bloom 0.62s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        .loader-ground {
          stroke: rgba(203, 233, 140, 0.5);
          stroke-width: 1.6;
          stroke-linecap: round;
          transform-box: fill-box;
          transform-origin: center;
          transform: scaleX(0);
          animation: loader-ground 0.9s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards;
        }

        .loader-copy {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          text-align: center;
          animation: loader-rise 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.45s both;
        }

        .loader-title {
          font-size: 21px;
          font-weight: 600;
          letter-spacing: 0.14em;
          padding-left: 0.14em;
        }

        .loader-status {
          display: inline-flex;
          align-items: baseline;
          justify-content: center;
          font-size: 12px;
          letter-spacing: 0.04em;
          color: rgba(203, 233, 140, 0.7);
          min-height: 1.15em;
          animation: status-in 0.5s ease both;
        }

        .loader-dots {
          display: inline-flex;
          width: 1.05em;
          margin-left: 1px;
          text-align: left;
        }

        .loader-dots span {
          opacity: 0.22;
          transform: translateY(0);
          animation: loader-dot 1.15s ease-in-out infinite;
        }

        .loader-dots span:nth-child(2) {
          animation-delay: 0.16s;
        }

        .loader-dots span:nth-child(3) {
          animation-delay: 0.32s;
        }

        .loader-detail {
          max-width: min(360px, 72vw);
          min-height: 1em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: rgba(255, 255, 255, 0.34);
          font-size: 10px;
          letter-spacing: 0.03em;
          font-variant-numeric: tabular-nums;
        }

        @keyframes status-in {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .loader-meter {
          width: min(260px, 52vw);
          height: 2px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.1);
          animation: loader-rise 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.55s both;
        }

        .loader-meter-fill {
          width: 100%;
          height: 100%;
          border-radius: inherit;
          position: relative;
          overflow: hidden;
          background: linear-gradient(90deg, #6f9a4d, #cbe98c, #d7a756);
          transform: scaleX(var(--load));
          transform-origin: left center;
          will-change: transform;
          transition: transform 80ms linear;
        }

        .loader-meter-fill::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.42),
            transparent
          );
          transform: translateX(-120%);
          animation: loader-sheen 1.55s linear infinite;
        }

        .loader-percent {
          color: rgba(203, 233, 140, 0.85);
          font-size: 12px;
          letter-spacing: 0.06em;
          font-variant-numeric: tabular-nums;
          animation: loader-rise 0.8s cubic-bezier(0.22, 1, 0.36, 1) 0.6s both;
        }

        @keyframes loader-enter {
          from {
            opacity: 0;
            transform: translateY(14px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes loader-rise {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes loader-dot {
          0%, 100% {
            opacity: 0.22;
            transform: translateY(0);
          }
          38% {
            opacity: 1;
            transform: translateY(-1px);
          }
        }

        @keyframes loader-sheen {
          to {
            transform: translateX(120%);
          }
        }

        @keyframes loader-draw {
          to {
            stroke-dashoffset: 0;
          }
        }

        @keyframes loader-bloom {
          0% {
            opacity: 0;
            transform: scale(0);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes loader-ground {
          to {
            transform: scaleX(1);
          }
        }

        @keyframes loader-sway {
          0%, 100% {
            transform: rotate(-1deg);
          }
          50% {
            transform: rotate(1deg);
          }
        }

        @keyframes loader-breathe {
          0%, 100% {
            opacity: 0.4;
            transform: translate(-50%, -50%) scale(0.97);
          }
          50% {
            opacity: 0.75;
            transform: translate(-50%, -50%) scale(1.04);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .loader-glow,
          .loader-canopy {
            animation: none;
          }
          .loader-branch {
            stroke-dashoffset: 0;
            animation: none;
          }
          .loader-leaf {
            opacity: 1;
            transform: scale(1);
            animation: none;
          }
          .loader-ground {
            transform: scaleX(1);
            animation: none;
          }
          .loader-dots span,
          .loader-meter-fill::after {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
