"use client";

import dynamic from "next/dynamic";
import localFont from "next/font/local";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useProgress } from "@react-three/drei";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChurchJourney } from "./MemorialChurch";
import styles from "./MemorialSecret.module.css";

const serif = localFont({
  src: [
    {
      path: "../public/fonts/cormorant-garamond.woff",
      weight: "300 700",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-memorial",
});
const MemorialChurch = dynamic(() => import("./MemorialChurch"), {
  ssr: false,
});
const MEMORIAL_LINK =
  "https://www.trauerhilfe.it/verstorbene/franz-plattner-gossensass/";
const CHAPTERS = ["Eingang", "Kirchenraum", "Gedenken"];
const CHAPTER_PROGRESS = [0, 0.48, 1];

function DoveMark() {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M7 23c7 0 9-5 10-13 4 4 5 8 4 12 3-2 5-4 8-5l4 2-4 2c-2 8-10 12-18 7l-5 2 1-7Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="m14 28 6-5M28 20h.01"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function MemorialSecret({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTrack = useRef<HTMLDivElement>(null);
  const journey = useRef<ChurchJourney>({ progress: 0, reducedMotion: false });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [chapter, setChapter] = useState(0);
  const { progress } = useProgress();
  const onSceneReady = useCallback(() => setReady(true), []);
  const onSceneError = useCallback(() => setFailed(true), []);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.style.cursor = "auto";
    if (document.pointerLockElement) document.exitPointerLock();
    root.current?.focus({ preventScroll: true });
    // Keep the background HUD inert, including for screen readers and Tab.
    const siblings = Array.from(
      root.current?.parentElement?.children ?? [],
    ).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== root.current,
    );
    const previousInert = siblings.map((element) => element.inert);
    siblings.forEach((element) => {
      element.inert = true;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
      }
      // The dialog receives initial focus without a decorative focus ring.
      // Let keyboard users start the walk immediately, before their first Tab.
      if (document.activeElement === root.current && scroller.current) {
        const element = scroller.current;
        const steps: Record<string, number> = {
          ArrowDown: 64,
          ArrowUp: -64,
          PageDown: element.clientHeight * 0.9,
          PageUp: -element.clientHeight * 0.9,
          " ": element.clientHeight * (event.shiftKey ? -0.9 : 0.9),
        };
        if (event.key in steps || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const top =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? element.scrollHeight
                : element.scrollTop + steps[event.key];
          element.scrollTo({
            top,
            behavior: journey.current.reducedMotion ? "instant" : "smooth",
          });
        }
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], [tabindex='0']",
        ) ?? [],
      ).filter(
        (element) =>
          !element.closest("[inert]") &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === root.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      siblings.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      window.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (
      (!ready && !failed) ||
      !root.current ||
      !scroller.current ||
      !scrollTrack.current
    )
      return;
    gsap.registerPlugin(ScrollTrigger);
    const rootElement = root.current;
    const media = gsap.matchMedia();
    media.add(
      {
        reduced: "(prefers-reduced-motion: reduce)",
        animated: "(prefers-reduced-motion: no-preference)",
      },
      (context) => {
        const reduced = Boolean(context.conditions?.reduced);
        journey.current.reducedMotion = reduced;
        const element = rootElement;
        const panels = element.querySelectorAll<HTMLElement>("[data-chapter]");
        const bar = element.querySelector("[data-progress]");
        const counter = element.querySelector("[data-counter]");
        let activeChapter = -2;
        const revealChapter = (next: number) => {
          if (next === activeChapter) return;
          activeChapter = next;
          setChapter(next);
          panels.forEach((panel, index) => {
            const active = next === index;
            panel.inert = !active;
            panel.setAttribute("aria-hidden", String(!active));
            if (reduced) return;
            context.add(() =>
              gsap.to(panel, {
                autoAlpha: active ? 1 : 0,
                y: active ? 0 : -12,
                duration: reduced ? 0 : 0.55,
                overwrite: true,
              }),
            );
          });
        };
        const update = (value: number) => {
          journey.current.progress = value;
          journey.current.invalidate?.();
          gsap.set(bar, { scaleX: value });
          if (counter)
            counter.textContent = `${Math.round(value * 100)
              .toString()
              .padStart(2, "0")}%`;
          // Leave stretches of the walk free of copy so the architecture has
          // room to breathe between the three moments.
          revealChapter(
            value < 0.19
              ? 0
              : value > 0.38 && value < 0.64
                ? 1
                : value > 0.84
                  ? 2
                  : -1,
          );
        };
        const position = { value: journey.current.progress };
        gsap.to(position, {
          value: 1,
          ease: "none",
          scrollTrigger: {
            scroller: scroller.current,
            trigger: scrollTrack.current,
            start: "top top",
            end: "bottom bottom",
            scrub: reduced ? true : 0.65,
            invalidateOnRefresh: true,
          },
          onUpdate: () => update(position.value),
        });
        update(position.value);
        gsap.fromTo(
          element.querySelector("[data-scene]"),
          { opacity: 0 },
          {
            opacity: 1,
            duration: reduced ? 0 : 1.2,
            ease: "power2.out",
          },
        );
        gsap.fromTo(
          element.querySelectorAll("[data-entrance]"),
          { opacity: 0, y: reduced ? 0 : 12 },
          {
            opacity: 1,
            y: 0,
            duration: reduced ? 0 : 1.1,
            stagger: reduced ? 0 : 0.08,
            delay: reduced ? 0 : 0.25,
          },
        );
        ScrollTrigger.refresh();
      },
      rootElement,
    );
    return () => media.revert();
  }, [ready, failed]);

  const goToChapter = (index: number) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({
      top:
        (element.scrollHeight - element.clientHeight) * CHAPTER_PROGRESS[index],
      behavior: journey.current.reducedMotion ? "instant" : "smooth",
    });
  };

  return (
    <div
      ref={root}
      className={`${styles.root} ${serif.variable}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="memorial-title"
      tabIndex={-1}
    >
      <div className={styles.scene} data-scene aria-hidden="true">
        <MemorialChurch
          key={attempt}
          journey={journey}
          onReady={onSceneReady}
          onError={onSceneError}
        />
      </div>
      <div className={styles.shade} aria-hidden="true" />
      <div
        ref={scroller}
        className={styles.scroller}
        tabIndex={0}
        aria-label="Durch die Kirche gehen. Mit den Pfeiltasten oder durch Scrollen weitergehen."
        style={{ overflowY: ready || failed ? "auto" : "hidden" }}
      >
        <div ref={scrollTrack} className={styles.scrollTrack} />
      </div>
      <header className={styles.header}>
        <div className={styles.signature} data-entrance>
          <span>Kirche in Boden</span>
        </div>
        <button
          className={styles.close}
          onClick={onClose}
          aria-label="Gedenkansicht schließen und zur Insel zurückkehren"
        >
          <span>Zurück zur Insel</span>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m6 6 12 12M18 6 6 18"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </header>
      {!ready && !failed && (
        <div className={styles.loader} role="status">
          <DoveMark />
          <p>Kirche in Boden</p>
          <span>3D-Raum wird geladen</span>
          <div className={styles.loadingLine}>
            <i
              style={{ transform: `scaleX(${Math.max(0.05, progress / 100)})` }}
            />
          </div>
        </div>
      )}
      {failed && (
        <div className={styles.error} role="status">
          <p>Der 3D-Raum konnte nicht geladen werden.</p>
          <button
            onClick={() => {
              setFailed(false);
              setReady(false);
              setAttempt((value) => value + 1);
            }}
          >
            Erneut versuchen ↗
          </button>
        </div>
      )}
      <div
        className={styles.panels}
        style={{ visibility: ready || failed ? "visible" : "hidden" }}
      >
        <section
          className={`${styles.chapter} ${styles.intro}`}
          data-chapter="0"
        >
          <div className={styles.introCopy}>
            <p className={styles.overline}>In Erinnerung an</p>
            <h1 id="memorial-title">Franz Plattner</h1>
            <p className={styles.dates}>14. Januar 1947 — 25. Juni 2026</p>
            <button className={styles.walkLink} onClick={() => goToChapter(1)}>
              Durch die Kirche gehen <span aria-hidden="true">↓</span>
            </button>
          </div>
        </section>
        <section
          className={`${styles.chapter} ${styles.remember}`}
          data-chapter="1"
          aria-hidden="true"
        >
          <p className={styles.overline}>Boden · Österreich</p>
          <h2>Kirche in Boden</h2>
        </section>
        <section
          className={`${styles.chapter} ${styles.farewell}`}
          data-chapter="2"
          aria-hidden="true"
        >
          <p className={styles.overline}>In Erinnerung an</p>
          <h2>Franz Plattner</h2>
          <p className={styles.dates}>14. Januar 1947 — 25. Juni 2026</p>
          <a
            className={styles.memorialLink}
            href={MEMORIAL_LINK}
            target="_blank"
            rel="noopener noreferrer"
          >
            Zur Gedenkseite <span aria-hidden="true">↗</span>
          </a>
        </section>
      </div>
      <nav
        className={styles.chapterNav}
        aria-label="Abschnitte der Erinnerung"
        style={{ visibility: ready || failed ? "visible" : "hidden" }}
        data-entrance
      >
        {CHAPTERS.map((name, index) => (
          <button
            key={name}
            onClick={() => goToChapter(index)}
            aria-label={`${index + 1}. ${name}`}
            aria-current={chapter === index ? "step" : undefined}
            className={chapter === index ? styles.current : ""}
          >
            <span>{name}</span>
            <i />
          </button>
        ))}
      </nav>
      <footer
        className={styles.footer}
        style={{ visibility: ready || failed ? "visible" : "hidden" }}
        data-entrance
      >
        <div className={styles.footerMeta}>
          <span>1947 — 2026</span>
          <span className={styles.scrollHint}>
            {chapter === 2
              ? "Ende des Rundgangs"
              : "Scrollen, um weiterzugehen"}
            <span aria-hidden="true">{chapter === 2 ? "·" : "↓"}</span>
          </span>
          <span data-counter>00%</span>
        </div>
        <div className={styles.progressTrack}>
          <i data-progress />
        </div>
        <a
          className={styles.credit}
          href="https://sketchfab.com/3d-models/inside-the-church-of-boden-austria-106c72c2a6474850b06132ab868969ae"
          target="_blank"
          rel="noopener noreferrer"
        >
          Kirche in Boden · 3D-Scan: Jan · CC BY 4.0
        </a>
      </footer>
    </div>
  );
}
