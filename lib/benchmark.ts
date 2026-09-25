"use client";

import * as THREE from "three";
import type { ResolvedGraphicsQuality } from "./quality";

// Picks the auto graphics tier with a short in-browser probe: a small hidden
// canvas renders an instanced, wind-shaded quad field (the same cost shape as
// the grass material) and the median GPU time per frame picks the tier.
//
// Each sample times render() plus a 1-pixel readPixels, which blocks until the
// GPU has finished the frame. Timing the gap between requestAnimationFrame
// callbacks instead would only measure the display refresh rate (16.7ms on
// every 60Hz screen, whatever the GPU).
//
// Falls back to a static heuristic whenever the probe can't produce a signal,
// e.g. in a background tab where requestAnimationFrame never fires, so it can
// never hang the caller.

const INSTANCE_COUNT = 6000;
const WARMUP_FRAMES = 3;
const MAX_SAMPLES = 20;
const SAMPLE_BUDGET_MS = 350;
const HARD_TIMEOUT_MS = 800; // setTimeout-based, independent of rAF ever firing

const VERTEX = /* glsl */ `
  attribute float aPhase;
  varying float vY;
  void main() {
    vY = position.y;
    vec3 p = position;
    float sway = sin(aPhase + position.y * 3.0) * position.y * 0.12;
    p.x += sway;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying float vY;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    float n = hash(gl_FragCoord.xy * 0.7) * 0.5 + hash(gl_FragCoord.xy * 1.9) * 0.5;
    vec3 col = mix(vec3(0.1, 0.25, 0.08), vec3(0.55, 0.7, 0.3), vY * 0.5 + n * 0.15);
    gl_FragColor = vec4(col, 1.0);
  }
`;

function heuristicFallback(): ResolvedGraphicsQuality {
  if (typeof navigator === "undefined") return "medium";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const narrow =
    typeof window !== "undefined" && Math.min(window.innerWidth, window.innerHeight) < 820;
  const touchFirst = navigator.maxTouchPoints > 1 && narrow;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? (touchFirst ? 4 : 8);
  if (touchFirst || cores <= 4 || memory <= 4) return "low";
  if (cores >= 8 && memory >= 8 && typeof window !== "undefined" && window.innerWidth >= 1280) {
    return "high";
  }
  return "medium";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classify(medianGpuMs: number): ResolvedGraphicsQuality {
  // Conservative on purpose: the probe is a small slice of the real scene
  // (no shadows, canopy, clouds or ants), so a borderline device gets the
  // lower tier. For reference, an Apple M3 Pro measures ~1.1ms and a software
  // renderer ~55ms.
  if (medianGpuMs < 2.5) return "high";
  if (medianGpuMs < 7) return "medium";
  return "low";
}

async function probe(): Promise<ResolvedGraphicsQuality | null> {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  if (document.hidden) return null; // rAF would never fire — bail immediately

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1;";
  document.body.appendChild(canvas);

  let renderer: THREE.WebGLRenderer | null = null;
  const cleanup = (geo?: THREE.BufferGeometry, mat?: THREE.Material) => {
    geo?.dispose();
    mat?.dispose();
    renderer?.dispose();
    // Browsers cap live WebGL contexts; release this one right away instead
    // of waiting for garbage collection.
    renderer?.forceContextLoss();
    canvas.remove();
  };

  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(256, 256, false);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);

    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(0.1, 1, 1, 3);
    geo.translate(0, 0.5, 0);
    const phases = new Float32Array(INSTANCE_COUNT);
    for (let i = 0; i < INSTANCE_COUNT; i++) phases[i] = Math.random() * Math.PI * 2;
    geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));

    const mat = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT });
    const mesh = new THREE.InstancedMesh(geo, mat, INSTANCE_COUNT);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      tmp.position.set((Math.random() - 0.5) * 12, 0, (Math.random() - 0.5) * 12 - 4);
      tmp.rotation.y = Math.random() * Math.PI;
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    scene.add(mesh);

    const gl = renderer.getContext();
    const pixel = new Uint8Array(4);
    const samples: number[] = [];
    let frame = 0;
    const start = performance.now();

    await new Promise<void>((resolve) => {
      function tick() {
        const t0 = performance.now();
        renderer!.render(scene, camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const t1 = performance.now();
        frame++;
        // The first frames include shader compilation.
        if (frame > WARMUP_FRAMES) samples.push(t1 - t0);
        if (
          t1 - start >= SAMPLE_BUDGET_MS ||
          samples.length >= MAX_SAMPLES ||
          document.hidden
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    cleanup(geo, mat);
    if (samples.length < 5) return null; // inconclusive: not enough samples
    return classify(median(samples));
  } catch {
    cleanup();
    return null;
  }
}

export async function runGraphicsBenchmark(): Promise<ResolvedGraphicsQuality> {
  const fallback = heuristicFallback();
  // Hard floors the GPU probe can't see (CPU-bound costs like the skinned
  // ants) always win.
  if (fallback === "low") return "low";

  const result = await Promise.race([
    probe(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HARD_TIMEOUT_MS)),
  ]).catch(() => null);

  return result ?? fallback;
}

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * True when WebGL is rendered on the CPU: hardware acceleration switched off
 * in the browser, a blocklisted GPU driver, or a VM without a GPU. Browsers
 * refuse a context with failIfMajorPerformanceCaveat in exactly that case;
 * the renderer name catches the ones that don't implement the flag.
 */
export function detectSoftwareRendering(): boolean {
  const release = (gl: WebGLRenderingContext | WebGL2RenderingContext) =>
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    // No WebGL 2 at all is a different problem (the scene can't start).
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    release(gl);
    if (SOFTWARE_RENDERERS.test(renderer)) return true;
    const fast = document
      .createElement("canvas")
      .getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (fast) release(fast);
    return !fast;
  } catch {
    return false;
  }
}
