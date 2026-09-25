"use client";

import { use, useEffect, useState } from "react";
import * as THREE from "three";
import { generateBark, type BarkPixels } from "./barkTexture";
import { buildCanopy, canopyKey, type CanopyData, type CanopyInput } from "./canopy";
import type { TreeJob } from "./tree.worker";

// The canopy and the bark texture take a second or more of solid CPU work
// each (several seconds on phones), so they're built in workers to keep the
// page responsive, one worker per kind so they run in parallel. Results are
// cached, so remounting the scene reuses them. Without worker support the same
// code runs on the main thread.

type Kind = TreeJob["kind"];
type Pending = { kind: Kind; resolve: (data: never) => void; fallback: () => unknown };

// A promise React's use() can read synchronously once it has settled (React
// reads and writes these same status/value fields).
export type TrackedPromise<T> = Promise<T> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: T;
};

function track<T>(promise: Promise<T>): TrackedPromise<T> {
  const tracked: TrackedPromise<T> = promise.then((value) => {
    tracked.status = "fulfilled";
    tracked.value = value;
    return value;
  });
  return tracked;
}

const workers = new Map<Kind, Worker | null>();
const pending = new Map<number, Pending>();
let nextId = 0;

function getWorker(kind: Kind): Worker | null {
  if (workers.has(kind)) return workers.get(kind)!;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./tree.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<{ id: number; data: never }>) => {
      pending.get(event.data.id)?.resolve(event.data.data);
      pending.delete(event.data.id);
    };
    worker.onerror = () => {
      // The worker failed to load or crashed: finish its jobs on the main
      // thread and build there from now on.
      worker?.terminate();
      workers.set(kind, null);
      for (const [id, job] of pending) {
        if (job.kind !== kind) continue;
        pending.delete(id);
        job.resolve(job.fallback() as never);
      }
    };
  } catch {
    worker = null;
  }
  workers.set(kind, worker);
  return worker;
}

function run<T>(job: TreeJob, fallback: () => T): Promise<T> {
  const worker = getWorker(job.kind);
  if (!worker) return Promise.resolve().then(fallback);
  return new Promise<T>((resolve) => {
    const id = nextId++;
    pending.set(id, { kind: job.kind, resolve: resolve as (data: never) => void, fallback });
    worker.postMessage({ ...job, id });
  });
}

// ---- canopy ----------------------------------------------------------------

const CANOPY_CACHE_SIZE = 3;
const canopyCache = new Map<string, TrackedPromise<CanopyData>>();

export function requestCanopy(input: CanopyInput): TrackedPromise<CanopyData> {
  const key = canopyKey(input);
  const hit = canopyCache.get(key);
  if (hit) {
    // Refresh its position so the most recently used entries survive.
    canopyCache.delete(key);
    canopyCache.set(key, hit);
    return hit;
  }
  const promise = track(run({ kind: "canopy", input }, () => buildCanopy(input)));
  canopyCache.set(key, promise);
  if (canopyCache.size > CANOPY_CACHE_SIZE) canopyCache.delete(canopyCache.keys().next().value!);
  return promise;
}

/**
 * The canopy for `input`. The first call suspends until it's built (the
 * scene's Suspense keeps the loading screen up meanwhile); after that, a new
 * input keeps returning the current canopy until the new one is ready, so the
 * tree never disappears while it regenerates.
 */
export function useCanopy(input: CanopyInput): CanopyData {
  const latest = requestCanopy(input);
  const [shown, setShown] = useState(latest);
  useEffect(() => {
    if (shown === latest) return;
    let alive = true;
    latest.then(() => {
      if (alive) setShown(latest);
    });
    return () => {
      alive = false;
    };
  }, [latest, shown]);
  const current: Promise<CanopyData> = latest.status === "fulfilled" ? latest : shown;
  return use(current);
}

// ---- bark ------------------------------------------------------------------

export type BarkTextures = { map: THREE.Texture; bump: THREE.Texture; rough: THREE.Texture };

const barkCache = new Map<number, TrackedPromise<BarkTextures>>();

// Same sampling setup the CanvasTexture version had (mipmapped, linear,
// tiled 3x around the trunk). The rows arrive bottom-up, so no flip.
function toTexture(data: Uint8Array, size: number, srgb: boolean): THREE.Texture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 1);
  texture.anisotropy = 16;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Bark textures at `size`, generated once per size for the page's lifetime. */
export function requestBarkTextures(size: number): TrackedPromise<BarkTextures> {
  let promise = barkCache.get(size);
  if (!promise) {
    promise = track(
      run<BarkPixels>({ kind: "bark", size }, () => generateBark(size)).then((p) => ({
        map: toTexture(p.color, p.size, true),
        bump: toTexture(p.bump, p.size, false),
        rough: toTexture(p.rough, p.size, false),
      })),
    );
    barkCache.set(size, promise);
  }
  return promise;
}
