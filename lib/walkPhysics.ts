"use client";

import { useEffect, useState } from "react";

// Loader for components/WalkPhysics.tsx. Kept free of heavy imports so the page
// can prefetch the physics chunk (e.g. when the Walk button is hovered)
// without pulling rapier into the initial bundle.

type WalkPhysics = typeof import("@/components/WalkPhysics");

let loaded: WalkPhysics | null = null;
let loading: Promise<WalkPhysics> | null = null;

export function loadWalkPhysics(): Promise<WalkPhysics> {
  loading ??= import("@/components/WalkPhysics")
    .then(async (mod) => {
      await mod.initPhysicsEngine();
      loaded = mod;
      return mod;
    })
    .catch((err: unknown) => {
      loading = null; // allow a retry on the next request
      throw err;
    });
  return loading;
}

/** The physics module once `wanted` has been requested and finished loading, else null. */
export function useWalkPhysics(wanted: boolean): WalkPhysics | null {
  const [mod, setMod] = useState(loaded);
  useEffect(() => {
    if (!wanted || mod) return;
    let alive = true;
    loadWalkPhysics().then(
      (m) => {
        if (alive) setMod(m);
      },
      () => {
        /* stays null; entering walk mode again retries the load */
      },
    );
    return () => {
      alive = false;
    };
  }, [wanted, mod]);
  return mod;
}
