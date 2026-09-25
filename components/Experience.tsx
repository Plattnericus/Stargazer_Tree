"use client";

import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Float,
  OrbitControls,
  PerformanceMonitor,
  Preload,
  useGLTF,
} from "@react-three/drei";
import {
  Bloom,
  EffectComposer,
  N8AO,
  SMAA,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { applyGrade, GradeEffectImpl } from "./GradeEffect";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import "@/lib/shaderPatches";
import { sampleIslandSurface } from "@/lib/surface";
import { Island } from "./Island";
import { Tree } from "./Tree";
import { Houses } from "./Houses";
import { Bridges } from "./Bridges";
import { Ants } from "./Ants";
import { Grass } from "./Grass";
import { GrassClumps } from "./GrassClumps";
import { Flora } from "./Flora";
import { Fireflies } from "./Fireflies";
import { FallingLeaves } from "./FallingLeaves";
import { Birds } from "./Birds";
import { Dove } from "./Dove";
import { Weather } from "./Weather";
import { SceneRig } from "./SceneRig";
import { Sky } from "./Sky";
import { NightSky } from "./NightSky";
import { CozyFlyControls } from "./CozyFlyControls";
import { treeHeight } from "@/lib/growth";
import { bonsaiAnchors, spineAt } from "@/lib/bonsai";
import { MAX_HOUSES } from "@/lib/layout";
import { deckRadius, TIER_SIZE, resolveTier } from "@/lib/rarity";
import type { CloudLayerParams, SceneParams } from "@/lib/weather";
import type { Stargazer } from "@/lib/stargazers";
import { ISLAND_SCALE, TREE_BOOST, TREE_Y } from "@/lib/scene";
import { useWalkPhysics } from "@/lib/walkPhysics";
import { NIGHT_LIGHT } from "@/lib/lantern";
import { updateVisibleMatrixWorld } from "@/lib/matrixUpdates";
import { frameStats, recordFrame, resetFrameStats } from "@/lib/frameStats";
import {
  QUALITY_PROFILES,
  QualityContext,
  useQualityProfile,
  type QualityProfile,
  type ResolvedGraphicsQuality as Quality,
} from "@/lib/quality";
import {
  cameraBus,
  DEFAULT_FOV,
  ROTATE_FAST_MULTIPLIER,
  ROTATE_SPEED,
  TILT_SPEED,
  ZOOM_FOV,
  type CamMode,
} from "@/lib/cameraBus";

const PLATEAU_Y = 6.7 * ISLAND_SCALE;
// Floors for the adaptive-quality knobs (see the PerformanceMonitor below).
const MIN_LEAF_DENSITY = 0.4;
const MIN_PERF_BUDGET = 0.45;
const PLATEAU_R = 10 * ISLAND_SCALE;
// Settling time after the scene mounts before adaptive quality starts judging.
const ADAPTIVE_WARMUP_MS = 4000;
// No tier renders more pixels than a 4K frame. Past that, supersampling a big
// screen only takes GPU time that adaptive quality would then win back from
// the canopy.
const MAX_FRAME_PIXELS = 3840 * 2160;

function readScreen() {
  if (typeof window === "undefined") return { ratio: 1, pixels: 0 };
  return { ratio: window.devicePixelRatio || 1, pixels: window.innerWidth * window.innerHeight };
}

// The pixel ratios a tier may use on this screen, kept current on resize.
function useDprRange(quality: QualityProfile) {
  const [screen, setScreen] = useState(readScreen);
  useEffect(() => {
    const update = () => setScreen(readScreen());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const native = quality.nativeDpr ? Math.min(screen.ratio, 2) : 0;
  const budget = screen.pixels > 0 ? Math.sqrt(MAX_FRAME_PIXELS / screen.pixels) : Infinity;
  const max = Math.max(quality.minDpr, Math.min(Math.max(quality.maxDpr, native), budget));
  // Big windows start inside the tier's pixel budget (a 2560x1440 monitor at
  // 1.2x would be 5.3 MP of fill); the adaptive loop can climb back to `max`.
  const fit = screen.pixels > 0 ? Math.sqrt(quality.idlePixels / screen.pixels) : Infinity;
  const idle = Math.min(Math.max(quality.idleDpr, native), max, Math.max(fit, 0.6));
  return { min: Math.min(quality.minDpr, idle), idle, max };
}

// Models every quality tier needs, loaded together behind one Suspense
// boundary. grass.glb is left out on purpose: GrassClumps loads it itself and
// is only mounted on tiers that draw tufts.
const MODEL_ASSETS = [
  "/models/ant.glb",
  "/models/bird_orange.glb",
  "/models/casual_village_buildings_pack.glb",
  "/models/island.glb",
  "/models/stylized_lantern.glb",
];

function AssetGate() {
  useGLTF(MODEL_ASSETS);
  return null;
}

const CLOUD_RANGE = 118;

export type { ResolvedGraphicsQuality } from "@/lib/quality";
const CLOUD_VERTEX = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uCoverage;
  uniform float uDensity;
  uniform float uHeight;
  uniform float uThickness;
  uniform float uScale;
  uniform float uOpacity;
  uniform float uSpeed;
  uniform float uDetail;
  uniform float uSteps;
  uniform float uRange;
  uniform float uFog;
  uniform vec2 uWindDir;
  uniform vec3 uBaseColor; // sky light + direct sun/moon light on a cloud top
  uniform vec3 uShadowColor; // sky light only (a shaded base)
  uniform vec3 uSunDir; // toward the key light (sun by day, moon by night)
  varying vec3 vWorldPos;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  // Cloud shape: 4 octaves (weights 0.55 * 0.48^k sum to 1.0016, and
  // noise() < 1); the 5th octave of the old shader was below a pixel at these
  // distances. FBM_MAX bounds both fbm4 and the rescaled fbm2 below.
  const float FBM_MAX = 1.002;
  float fbm4(vec3 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 4; i++) {
      v += noise(p) * a;
      p = p * 2.07 + vec3(13.1, 7.7, 4.9);
      a *= 0.48;
    }
    return v;
  }
  // Two octaves (max 0.814), for the erosion detail and the light probe.
  float fbm2(vec3 p) {
    return noise(p) * 0.55 + noise(p * 2.07 + vec3(13.1, 7.7, 4.9)) * 0.264;
  }

  vec2 boxHit(vec3 ro, vec3 rd, vec3 mn, vec3 mx) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (mn - ro) * inv;
    vec3 t1 = (mx - ro) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
  }

  // Henyey-Greenstein, normalized so isotropic scattering is 1.
  float hg(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  }

  void main() {
    if (uCoverage < 0.015 || uDensity < 0.01 || uOpacity < 0.01) discard;
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - ro);
    float halfT = uThickness * 0.5;
    vec3 mn = vec3(-uRange, uHeight - halfT, -uRange);
    vec3 mx = vec3(uRange, uHeight + halfT, uRange);
    vec2 hit = boxHit(ro, rd, mn, mx);
    if (hit.x > hit.y || hit.y < 0.0) discard;

    float start = max(hit.x, 0.0);
    float end = hit.y;
    float rayLen = min(end - start, 95.0);
    if (rayLen <= 0.0) discard;

    float steps = clamp(uSteps, 6.0, 30.0);
    float stride = rayLen / steps;
    // Interleaved gradient noise on the march offset: spreads the step
    // banding into a finer, more even pattern than a sine hash.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec2 wind = normalize(uWindDir);
    vec3 lightDir = normalize(uSunDir);
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    float threshold = mix(0.86, 0.32, clamp(uCoverage, 0.0, 1.0));
    // Loop-invariant terms, computed once per pixel instead of per step.
    vec2 drift = wind * uTime * uSpeed;
    float detailScale = 2.0 + uDetail;
    // Dual-lobe phase: a bright silver lining toward the sun/moon plus a soft
    // back-scatter glow, like real cumulus.
    float mu = dot(rd, lightDir);
    float phase = mix(hg(mu, 0.5), hg(mu, -0.2), 0.35) * 0.8;
    // Probe offset toward the light, in noise space (see q below).
    vec3 lightStep = vec3(lightDir.x * uScale, lightDir.y * uScale * 0.42, lightDir.z * uScale) * 3.2;
    vec3 directCol = uBaseColor - uShadowColor;

    // Samples that can't contribute are skipped before the expensive noise.
    // Every skip is exact: such a sample has edge == 0, so a == 0 and it
    // would add nothing to color or alpha.
    for (int i = 0; i < 32; i++) {
      if (float(i) >= steps || alpha > 0.965) break;
      float fi = (float(i) + jitter) / steps;
      vec3 p = ro + rd * (start + fi * rayLen);
      // Height in the layer: flat-ish bases, rounded tops (cumulus profile).
      float hf = clamp((p.y - (uHeight - halfT)) / uThickness, 0.0, 1.0);
      float vertical = smoothstep(0.0, 0.18, hf) * (1.0 - smoothstep(0.5, 1.0, hf));
      if (vertical <= 0.0) continue;
      vec3 q = vec3((p.xz + drift).x * uScale, p.y * uScale * 0.42, (p.xz + drift).y * uScale);
      float large = fbm4(q * 0.68);
      // n = mix(large, detail, 0.33) with detail <= 0.814 * 1.23 < FBM_MAX:
      // if even the largest detail can't lift n over the threshold, skip
      // the rest (exact, like the other skips).
      if (mix(large, FBM_MAX, 0.33) <= threshold) continue;
      float detail = fbm2(q * detailScale) * 1.23;
      float n = mix(large, detail, 0.33);
      float edge = smoothstep(threshold, threshold + 0.23, n) * vertical;
      if (edge <= 0.0) continue;
      float d = edge * uDensity;
      // Self-shadow: how much cloud sits a few units toward the light
      // (Beer's law), plus the powder term that darkens the thin sunlit
      // edges of dense clouds the way real ones do.
      float occ = smoothstep(threshold - 0.05, threshold + 0.28, fbm2((q + lightStep) * 0.68) * 1.23);
      float beer = exp(-occ * uDensity * 2.4);
      float powder = 1.0 - exp(-d * 3.0);
      float direct = beer * mix(1.0, powder, 0.55) * phase * mix(0.55, 1.0, hf);
      vec3 sampleColor = uShadowColor * mix(0.6, 1.05, hf) + directCol * direct;
      float a = 1.0 - exp(-d * stride * 0.075);
      a *= (1.0 - alpha);
      color += sampleColor * a;
      alpha += a;
    }

    // color is premultiplied by the march's own alpha: un-premultiply with
    // THAT alpha before the layer opacity scales it (dividing by the scaled
    // alpha, as before, brightened thin layers by 1/opacity).
    vec3 cloudCol = color / max(alpha, 0.001);
    alpha *= uOpacity * (1.0 - clamp(uFog * 0.18, 0.0, 0.18));
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(cloudCol, alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
  }
`;

function CloudVolumeLayer({
  layer,
  height,
  params,
  quality,
  order,
  visible = true,
}: {
  layer: CloudLayerParams;
  height: number;
  params: SceneParams;
  quality: number;
  order: number;
  visible?: boolean;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const profile = useQualityProfile();
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uCoverage: { value: layer.coverage },
      uDensity: { value: layer.density },
      uHeight: { value: height },
      uThickness: { value: layer.thickness },
      uScale: { value: layer.scale },
      uOpacity: { value: layer.opacity },
      uSpeed: { value: layer.speed },
      uDetail: { value: layer.detail },
      uSteps: { value: 18 },
      uRange: { value: CLOUD_RANGE },
      uFog: { value: params.clouds.fog },
      uWindDir: { value: new THREE.Vector2(params.windVec[0], params.windVec[1]) },
      uBaseColor: { value: new THREE.Color(params.clouds.baseColor) },
      uShadowColor: { value: new THREE.Color(params.clouds.shadowColor) },
      uSunDir: { value: new THREE.Vector3(...params.sunPos).normalize() },
    }),
    [],
  );

  useFrame((state, dt) => {
    const m = material.current;
    if (!m) return;
    const k = Math.min(1, dt * 0.9);
    m.uniforms.uTime.value = state.clock.elapsedTime;
    m.uniforms.uHeight.value = height;
    m.uniforms.uCoverage.value += (layer.coverage - m.uniforms.uCoverage.value) * k;
    m.uniforms.uDensity.value += (layer.density - m.uniforms.uDensity.value) * k;
    m.uniforms.uOpacity.value += (layer.opacity - m.uniforms.uOpacity.value) * k;
    m.uniforms.uSpeed.value += (layer.speed * (1 + params.gust * 0.18) - m.uniforms.uSpeed.value) * k;
    m.uniforms.uFog.value += (params.clouds.fog - m.uniforms.uFog.value) * k;
    m.uniforms.uSteps.value = Math.round(
      THREE.MathUtils.lerp(6, profile.cloudMaxSteps, quality),
    );
    (m.uniforms.uWindDir.value as THREE.Vector2).set(params.windVec[0], params.windVec[1]).normalize();
    (m.uniforms.uBaseColor.value as THREE.Color).set(params.clouds.baseColor);
    (m.uniforms.uShadowColor.value as THREE.Color).set(params.clouds.shadowColor);
    // Lit by the key light: the sun by day, the moon at night.
    (m.uniforms.uSunDir.value as THREE.Vector3).set(...params.keyLight.pos).normalize();
    // The fragment shader discards every pixel below these limits; skipping
    // the draw avoids a full-screen raymarch that produces nothing.
    if (mesh.current) {
      mesh.current.visible =
        visible &&
        m.uniforms.uCoverage.value >= 0.015 &&
        m.uniforms.uDensity.value >= 0.01 &&
        m.uniforms.uOpacity.value >= 0.01;
    }
  });

  return (
    <mesh
      ref={mesh}
      position={[0, height, 0]}
      renderOrder={order}
      frustumCulled={false}
      visible={visible}
    >
      <boxGeometry args={[CLOUD_RANGE * 2, layer.thickness, CLOUD_RANGE * 2, 1, 1, 1]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={CLOUD_VERTEX}
        fragmentShader={CLOUD_FRAGMENT}
        transparent
        depthWrite={false}
        depthTest
        side={THREE.BackSide}
      />
    </mesh>
  );
}

// The low deck floats as a sea of cloud below the island (whose rock ends at
// y ≈ -7.6); the mid and high decks ride above the crown, however tall the
// tree has grown. Fixed heights used to slice straight through a big tree and
// wrap the orbit camera in cloud.
const CLOUD_SEA_Y = -22;

function VolumetricClouds({
  params,
  quality,
  moving,
  treeTop,
}: {
  params: SceneParams;
  quality: number;
  moving: boolean;
  treeTop: number;
}) {
  const profile = useQualityProfile();
  // The tree stays the same while the camera moves; the extra layers are only
  // hidden, so starting/stopping a drag never remounts a cloud material.
  const extraLayers = !moving && profile.cloudLayers > 1;
  const midY = Math.max(params.clouds.mid.height, treeTop + 14);
  const highY = Math.max(params.clouds.high.height, midY + 22);

  return (
    <group>
      {profile.cloudLayers === 3 && (
        <CloudVolumeLayer
          layer={params.clouds.high}
          height={highY}
          params={params}
          quality={quality * 0.84}
          order={-3}
          visible={extraLayers}
        />
      )}
      <CloudVolumeLayer layer={params.clouds.mid} height={midY} params={params} quality={quality} order={-2} />
      {profile.cloudLayers > 1 && (
        <CloudVolumeLayer
          layer={params.clouds.low}
          height={CLOUD_SEA_Y}
          params={params}
          quality={quality * 0.92}
          order={-1}
          visible={extraLayers}
        />
      )}
    </group>
  );
}

// Reads the DOM rotate-controls bus and drives the orbit camera (left/right
// spin + up/down tilt). Kept as a tiny useFrame component so button presses
// never touch React state per frame.
function CameraRotateDriver() {
  useFrame((state, dt) => {
    const camera = state.camera as THREE.PerspectiveCamera;
    const targetFov = cameraBus.zoom ? ZOOM_FOV : cameraBus.baseFov;
    if (Math.abs(camera.fov - targetFov) > 0.02) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
    if (cameraBus.rotate === 0 && cameraBus.tilt === 0) return;
    const controls = state.controls as unknown as {
      getAzimuthalAngle?: () => number;
      setAzimuthalAngle?: (a: number) => void;
      getPolarAngle?: () => number;
      setPolarAngle?: (a: number) => void;
    } | null;
    if (!controls?.getAzimuthalAngle || !controls.setAzimuthalAngle) return;
    const fast = cameraBus.fast ? ROTATE_FAST_MULTIPLIER : 1;
    if (cameraBus.rotate !== 0) {
      controls.setAzimuthalAngle(
        controls.getAzimuthalAngle() + cameraBus.rotate * ROTATE_SPEED * fast * dt,
      );
    }
    if (cameraBus.tilt !== 0 && controls.getPolarAngle && controls.setPolarAngle) {
      const next = THREE.MathUtils.clamp(
        controls.getPolarAngle() - cameraBus.tilt * TILT_SPEED * fast * dt,
        0.12,
        Math.PI / 1.8 - 0.01,
      );
      controls.setPolarAngle(next);
    }
  });
  return null;
}

type HouseFocusTarget = {
  target: [number, number, number];
  cameraPosition: [number, number, number];
};

function CameraFocusRig({
  defaultTarget,
  focusTarget,
  focusKey,
}: {
  defaultTarget: [number, number, number];
  focusTarget: HouseFocusTarget | null;
  focusKey: number | null;
}) {
  const desiredTarget = useRef(new THREE.Vector3());
  const desiredCamera = useRef(new THREE.Vector3());
  const driveCamera = useRef(false);
  const hasFocus = focusTarget !== null;

  // Fly the camera over once per newly focused house. focusTarget itself is
  // recomputed whenever the stargazer data refreshes; that must not yank the
  // camera back after the user has orbited away.
  useEffect(() => {
    driveCamera.current = hasFocus;
  }, [focusKey, hasFocus]);

  useFrame((state, dt) => {
    const controls = state.controls as unknown as {
      target?: THREE.Vector3;
      update?: () => void;
    } | null;
    if (!controls?.target) return;

    const target = focusTarget?.target ?? defaultTarget;
    desiredTarget.current.set(target[0], target[1], target[2]);
    const targetEase = 1 - Math.exp(-dt * (focusTarget ? 5.2 : 3.4));
    controls.target.lerp(desiredTarget.current, targetEase);

    if (focusTarget && driveCamera.current) {
      desiredCamera.current.set(
        focusTarget.cameraPosition[0],
        focusTarget.cameraPosition[1],
        focusTarget.cameraPosition[2],
      );
      state.camera.position.lerp(desiredCamera.current, 1 - Math.exp(-dt * 3.9));
      if (state.camera.position.distanceToSquared(desiredCamera.current) < 0.035) {
        driveCamera.current = false;
      }
    }

    controls.update?.();
    // NOTE: no positive render-priority here — any useFrame priority > 0 turns
    // OFF R3F's automatic gl.render, which blanks the whole scene on tiers
    // without the EffectComposer (low/medium). Default priority keeps auto-render.
  });

  return null;
}

// Renders its children only once `ms` have passed since it mounted.
function AfterWarmup({ ms, children }: { ms: number; children: ReactNode }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setDone(true), ms);
    return () => window.clearTimeout(id);
  }, [ms]);
  return done ? children : null;
}

function SceneReadySignal({ onReady }: { onReady?: () => void }) {
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    fired.current = true;
    requestAnimationFrame(() => onReady?.());
  });
  return null;
}

// The EffectComposer does tone mapping itself and sets the renderer to
// NoToneMapping, but doesn't restore it while disabled (camera moving) or on
// tiers without post. Re-assert ACES on the renderer whenever the composer is
// not the one rendering; checked per frame so the transition frame can't win.
function ToneMappingBridge({ composerAsleep }: { composerAsleep: boolean }) {
  const gl = useThree((s) => s.gl);
  useFrame(() => {
    const want = composerAsleep ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    if (gl.toneMapping !== want) {
      gl.toneMapping = want;
      gl.toneMappingExposure = 1.12;
    }
  });
  return null;
}

// The single owner of shadow-map refreshes (renderer.shadowMap.autoUpdate is
// off, see onCreated): re-render the shadow map every `stride`-th frame.
// Shadows live in world space, so camera movement never changes them; only
// the slow sun and the swaying casters do, and those read fine at 30Hz.
function ShadowThrottle({ stride = 2 }: { stride?: number }) {
  const gl = useThree((s) => s.gl);
  const frame = useRef(0);
  useFrame(() => {
    frame.current = (frame.current + 1) % stride;
    gl.shadowMap.needsUpdate = frame.current === 0;
  }, -1);
  return null;
}

// Every lit material needs a separate shader program for each runtime state it
// can be drawn in: lantern lights on or off (see NIGHT_LIGHT in
// lib/lantern.ts), and drawn by the post composer (into a render target:
// linear output, no tone mapping) or straight to the screen while the composer
// sleeps during camera moves and open menus (ACES in the shader). Only the
// state of the first frame gets compiled up front; any other one would freeze
// the frame it's first needed in (the first drag, the first dusk). So compile
// all four combinations once, a few frames after mount while the loading
// overlay still covers the scene. compileAsync reads the renderer and light
// state synchronously, so everything is restored right away.
function PrewarmShaderVariants() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const frames = useRef(0);
  useFrame(() => {
    if (frames.current > 3) return;
    if (++frames.current <= 3) return;
    const lights: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.name === NIGHT_LIGHT) lights.push(o);
    });
    const flipLights = () => {
      for (const light of lights) light.visible = !light.visible;
    };
    const target = new THREE.WebGLRenderTarget(1, 1);
    const prevTarget = gl.getRenderTarget();
    const prevToneMapping = gl.toneMapping;
    const paths: [THREE.WebGLRenderTarget | null, THREE.ToneMapping][] = [
      [target, THREE.NoToneMapping],
      [null, THREE.ACESFilmicToneMapping],
    ];
    for (const flip of lights.length ? [false, true] : [false]) {
      if (flip) flipLights();
      for (const [renderTarget, toneMapping] of paths) {
        gl.setRenderTarget(renderTarget);
        gl.toneMapping = toneMapping;
        gl.compileAsync(scene, camera).catch(() => {});
      }
      if (flip) flipLights();
    }
    gl.setRenderTarget(prevTarget);
    gl.toneMapping = prevToneMapping;
    target.dispose();
  });
  return null;
}

// Replaces three.js' per-render scene.updateMatrixWorld() with a pass that
// skips hidden subtrees (see lib/matrixUpdates.ts). It runs from
// scene.onBeforeRender, i.e. after every useFrame has moved things and right
// before objects are projected and shadows drawn, at most once per frame even
// when post-processing renders the scene more than once.
function VisibleMatrixUpdates() {
  const scene = useThree((s) => s.scene);
  const frame = useRef(0);
  useFrame(() => {
    frame.current++;
  });
  useLayoutEffect(() => {
    let updatedFrame = -1;
    const previous = scene.onBeforeRender;
    scene.matrixWorldAutoUpdate = false;
    scene.onBeforeRender = function (...args) {
      if (updatedFrame !== frame.current) {
        updatedFrame = frame.current;
        updateVisibleMatrixWorld(scene, false);
      }
      previous.apply(this, args);
    };
    return () => {
      scene.matrixWorldAutoUpdate = true;
      scene.onBeforeRender = previous;
    };
  }, [scene]);
  return null;
}

// Feeds the FPS overlay (lib/frameStats.ts); mounted only while it's shown.
// three resets its draw counters on every render() call, which would leave
// just the last post-processing pass, so they're totalled per frame instead.
function FrameStatsProbe() {
  const gl = useThree((s) => s.gl);
  const last = useRef(0);
  useEffect(() => {
    resetFrameStats();
    gl.info.autoReset = false;
    gl.info.reset();
    // A hidden tab stops the loop; that gap isn't a slow frame.
    const onVisibility = () => {
      last.current = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      gl.info.autoReset = true;
    };
  }, [gl]);
  useFrame(() => {
    const now = performance.now();
    if (last.current) recordFrame(now - last.current);
    last.current = now;
    frameStats.calls = gl.info.render.calls;
    frameStats.triangles = gl.info.render.triangles;
    gl.info.reset();
    frameStats.width = gl.domElement.width;
    frameStats.height = gl.domElement.height;
    frameStats.dpr = gl.getPixelRatio();
  });
  return null;
}

// Dev-only handle for the headless visual tests (like window.__sceneParams in
// app/page.tsx): lets a test script place the camera deterministically.
function DevHandle() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __three?: unknown }).__three = { gl, scene, camera, controls, setDpr };
  }, [gl, scene, camera, controls, setDpr]);
  return null;
}

// Fills the island plateau using the sampled island surface.
function Plateau({
  wind,
  gust,
  windVec,
  night,
  season,
  cloudCover = 0,
  grassBlades,
  grassTufts,
  budget = 1,
  moving = false,
  aerial = 0,
  hazeColor,
}: {
  wind: number;
  gust: number;
  windVec: [number, number];
  night: number;
  season: SceneParams["season"];
  cloudCover?: number;
  grassBlades: number;
  grassTufts: number;
  budget?: number;
  moving?: boolean;
  aerial?: number;
  hazeColor?: string;
}) {
  const { scene } = useGLTF("/models/island.glb");
  const profile = useQualityProfile();
  const ambientBudget = THREE.MathUtils.clamp(budget, 0.45, 1);
  const surface = useMemo(
    () => sampleIslandSurface(scene, ISLAND_SCALE),
    [scene],
  );
  return (
    <>
      <Grass wind={wind} gust={gust} windVec={windVec} cloudCover={cloudCover} count={grassBlades} surface={surface} aerial={aerial} hazeColor={hazeColor} />
      {grassTufts > 0 && (
        <GrassClumps wind={wind} gust={gust} windVec={windVec} cloudCover={cloudCover} count={grassTufts} surface={surface} aerial={aerial} hazeColor={hazeColor} />
      )}
      <Flora radius={PLATEAU_R + 2} surface={surface} />
      <Fireflies
        night={night}
        count={Math.max(8, Math.round(profile.fireflies * ambientBudget))}
        maxCount={profile.fireflies}
        baseY={PLATEAU_Y - 0.5}
        radius={PLATEAU_R + 1}
        height={11}
      />
      <FallingLeaves
        wind={wind}
        gust={gust}
        windVec={windVec}
        season={season}
        surface={surface}
        treeY={TREE_Y}
        radius={PLATEAU_R + 2}
        budget={ambientBudget}
        moving={moving}
      />
    </>
  );
}

export default function Experience({
  stars,
  params,
  highlight = -1,
  focusedHouse = null,
  camMode = "orbit",
  stargazers = null,
  graphicsQuality = "medium",
  uiOverlayOpen = false,
  showStats = false,
  onSelectHouse,
  onFindDove,
  onReady,
  onIntroChange,
}: {
  stars: number;
  params: SceneParams;
  highlight?: number;
  focusedHouse?: number | null;
  camMode?: CamMode;
  stargazers?: Stargazer[] | null;
  graphicsQuality?: Quality;
  uiOverlayOpen?: boolean;
  /** Collect the numbers for the FPS overlay. */
  showStats?: boolean;
  onSelectHouse?: (i: number) => void;
  onFindDove?: () => void;
  onReady?: () => void;
  onIntroChange?: (introing: boolean) => void;
}) {
  const quality = QUALITY_PROFILES[graphicsQuality];
  // Night factor drives warm lights and fireflies.
  const night = Math.min(1, Math.max(0, 1 - params.dayFactor * 1.5));
  // Fill-light colors, eased from warm day tones to cool moonlit ones. (The
  // sun disc itself is drawn by the sky dome, see components/Sky.tsx.)
  const nightStep = Math.round(night * 20) / 20;
  const [fillSky, fillGround, fillKey] = useMemo(
    () => [
      new THREE.Color("#f8dfb8").lerp(new THREE.Color("#8c9fcc"), nightStep),
      new THREE.Color("#3f3326").lerp(new THREE.Color("#1c2230"), nightStep),
      new THREE.Color("#ffd29a").lerp(new THREE.Color("#7f97cf"), nightStep),
    ],
    [nightStep],
  );
  // Quality presets keep motion responsive without dropping the scene into a visibly pixelated state.
  const dprRange = useDprRange(quality);
  const [dprState, setDpr] = useState(dprRange.idle);
  const dpr = Math.min(dprState, dprRange.max);
  const [cloudQuality, setCloudQuality] = useState(quality.idleCloudQuality);
  // Extra degrade knob: scales particle budgets down when the GPU struggles,
  // so PerformanceMonitor has more to give back than resolution alone.
  const [perfBudget, setPerfBudget] = useState(1);
  // Last-resort degrade: swap real leaf shadows back to the cheap proxy.
  const [shadowFallback, setShadowFallback] = useState(false);
  // Share of canopy leaf sprigs drawn: the first knob adaptive quality turns.
  const [leafDensity, setLeafDensity] = useState(1);
  const [cameraMoving, setCameraMoving] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const flying = camMode !== "orbit";
  // Physics only runs in walk mode. The rapier module is loaded the first time
  // walk mode opens, and from then on the physics world and its colliders are
  // kept, so switching back and forth doesn't re-cook them. Visitors who never
  // walk never download it.
  const inPhysics = camMode === "walk";
  const walkPhysics = useWalkPhysics(inPhysics);
  const everEnteredPhysicsRef = useRef(false);
  if (inPhysics && walkPhysics) everEnteredPhysicsRef.current = true;
  const physics = everEnteredPhysicsRef.current ? walkPhysics : null;
  const interactionMoving = flying || cameraMoving;
  const performanceMoving = interactionMoving || uiOverlayOpen;
  // A DPR change reallocates the drawing buffer and every post-processing
  // target, which costs far more than the few pixels it saves. So only the
  // long-lived fly/walk modes use the motion DPR; a short orbit drag keeps
  // the idle resolution instead of hitching at its start and end.
  const effectiveDpr = flying ? Math.min(dpr, quality.movingDpr) : dpr;
  const effectiveCloudQuality = performanceMoving
    ? Math.min(cloudQuality, quality.movingCloudQuality * 0.65)
    : cloudQuality;

  // A new quality tier starts from its own defaults, not the previous tier's
  // adaptive state.
  useEffect(() => {
    setDpr(dprRange.idle);
    setCloudQuality(quality.idleCloudQuality);
    setPerfBudget(1);
    setLeafDensity(1);
    setShadowFallback(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a tier change resets; a resize just re-clamps (see dprRange)
  }, [quality]);

  useEffect(() => {
    return () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    };
  }, []);

  const markCameraMoving = () => {
    setCameraMoving(true);
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
  };

  const markCameraSettling = () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setCameraMoving(false), 420);
  };

  useEffect(() => {
    if (focusedHouse === null) return;
    markCameraMoving();
    const id = window.setTimeout(markCameraSettling, 960);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus changes are the only trigger.
  }, [focusedHouse]);

  // Orbit around the current trunk center.
  const worldH = treeHeight(stars) * TREE_BOOST;
  // A grown tree pushes the camera far out — scale the fog band with it so
  // the scene never sinks into a white wash at high star counts.
  const fogScale = THREE.MathUtils.clamp(worldH / 12, 1, 3.2);
  const trunkTargetLocal = spineAt(Math.max(3.8, treeHeight(stars) * 0.52));
  const orbitTarget: [number, number, number] = [
    trunkTargetLocal.x * TREE_BOOST,
    TREE_Y + trunkTargetLocal.y * TREE_BOOST,
    trunkTargetLocal.z * TREE_BOOST,
  ];
  const houseAnchors = useMemo(() => bonsaiAnchors(MAX_HOUSES), []);
  const focusTarget = useMemo<HouseFocusTarget | null>(() => {
    if (focusedHouse === null) return null;
    const active = Math.min(houseAnchors.length, Math.max(0, Math.floor(stars)));
    const anchor = houseAnchors[focusedHouse];
    if (!anchor || focusedHouse >= active) return null;

    const tier = resolveTier(focusedHouse, stargazers);
    const size = TIER_SIZE[tier];
    const deck = deckRadius(focusedHouse, stargazers) * TREE_BOOST;
    const target = new THREE.Vector3(
      anchor.pos.x * TREE_BOOST,
      TREE_Y + (anchor.pos.y + 0.72 + size * 0.46) * TREE_BOOST,
      anchor.pos.z * TREE_BOOST,
    );
    const radial = new THREE.Vector3(anchor.pos.x, 0, anchor.pos.z);
    if (radial.lengthSq() < 0.001) radial.set(1, 0, 1);
    radial.normalize();
    const distance = THREE.MathUtils.clamp(deck * 4.9 + 7.2, 10, 18);
    const lift = THREE.MathUtils.clamp(size * 2.4 + 2.8, 4.4, 7.4);
    const cameraPosition = target.clone().add(
      new THREE.Vector3(radial.x * distance, lift, radial.z * distance),
    );

    return {
      target: [target.x, target.y, target.z],
      cameraPosition: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
    };
  }, [focusedHouse, houseAnchors, stargazers, stars]);
  const camMax = THREE.MathUtils.clamp(worldH * 1.6 + 26, 40, 340);
  const ambientBudget = THREE.MathUtils.clamp(perfBudget, MIN_PERF_BUDGET, 1);
  const birdCount = Math.max(2, Math.round(4 * ambientBudget));
  const postEnabled =
    quality.bloom || quality.smaa || quality.ao || quality.grade || quality.vignette;
  const postprocessingSamples = quality.postprocessingSamples;
  // EffectComposer children must be JSX elements (no `false`), so build the post
  // chain as an array. It is memoized on purpose: EffectComposer rebuilds all
  // of its passes (and recompiles their shaders) whenever `children` changes
  // identity, and this component re-renders at the start and end of every
  // camera drag. Twilight is snapped to 5% steps so a sunset rebuilds the
  // chain a handful of times instead of on every clock tick.
  const twilight = Math.round(params.twilight * 20) / 20;
  // Color grade: one stable effect instance, its uniforms follow the light.
  // Golden hour warms the highlights, night cools the shadows (moonlight).
  const grade = useMemo(() => new GradeEffectImpl(), []);
  useEffect(() => () => grade.dispose(), [grade]);
  useEffect(() => {
    applyGrade(grade, {
      contrast: quality.grade ? 0.22 : 0.12,
      saturation: 0.1 + twilight * 0.1 - nightStep * 0.12,
      vibrance: 0.18,
      shadowTint: [-0.006 * nightStep, 0.002 * nightStep, 0.02 * nightStep],
      highlightTint: [1 + twilight * 0.04, 1 + twilight * 0.01, 1 - twilight * 0.05],
    });
  }, [grade, quality.grade, twilight, nightStep]);
  const postEffects = useMemo(() => {
    const effects: ReactElement[] = [];
    if (!postEnabled) return effects;
    if (quality.ao)
      effects.push(<N8AO key="ao" halfRes aoRadius={1.6} intensity={1.7} distanceFalloff={1} />);
    if (quality.bloom)
      effects.push(
        <Bloom
          key="bloom"
          mipmapBlur
          intensity={0.62 + twilight * 0.5}
          luminanceThreshold={0.75 - twilight * 0.18}
          luminanceSmoothing={0.3}
        />,
      );
    // Tone mapping first, then the grade in display space (see GradeEffect).
    effects.push(<ToneMapping key="tone" mode={ToneMappingMode.ACES_FILMIC} />);
    effects.push(<primitive key="grade" object={grade} dispose={null} />);
    if (quality.vignette)
      effects.push(<Vignette key="vig" eskil={false} offset={0.3} darkness={0.6} />);
    if (quality.smaa) effects.push(<SMAA key="smaa" />);
    return effects;
  }, [postEnabled, quality, twilight, grade]);

  // Houses and bridges get trimesh colliders once walk mode has loaded physics.
  const withColliders = (node: ReactElement) =>
    physics ? <physics.MeshColliders>{node}</physics.MeshColliders> : node;

  const sceneContent = (
    <>
      <QualityContext.Provider value={quality}>
      <Suspense fallback={null}>
        <AssetGate />
        {/* Adaptive quality holds 60 fps. Once most of a 2.5 s window drops
            frames it steps down one knob at a time: first the canopy thins
            (it's the main GPU load, and changing it costs nothing), then
            resolution, cloud steps and particle budgets together, and last
            the real leaf shadows on Ultra. A 60 Hz screen can't show spare
            headroom (it caps at 60), so only high-refresh screens step back
            up, in reverse order.
            drei counts the timestamps in each 250 ms sample, one more than
            the frame intervals, so it reads ~7% high: a clean 60 fps shows
            as 64 and a sample with a dropped frame as 60 or less, hence the
            lower bound of 62. (Its refresh-rate guess is just the best sample
            so far, which on a struggling GPU is the GPU's own rate, so it
            can't lower the bound.) It starts after a warm-up, so the texture
            uploads and shader compiles right after loading can't cost quality
            for good. */}
        <AfterWarmup ms={ADAPTIVE_WARMUP_MS}>
          <PerformanceMonitor
            bounds={(refreshRate) => (refreshRate > 90 ? [62, 100] : [62, Infinity])}
            onDecline={() => {
              if (leafDensity > MIN_LEAF_DENSITY) {
                setLeafDensity(Math.max(MIN_LEAF_DENSITY, +(leafDensity * 0.8).toFixed(2)));
                return;
              }
              if (
                dpr > dprRange.min ||
                cloudQuality > quality.movingCloudQuality ||
                perfBudget > MIN_PERF_BUDGET
              ) {
                setDpr(Math.max(dprRange.min, +(dpr - 0.18).toFixed(2)));
                setCloudQuality(Math.max(quality.movingCloudQuality, +(cloudQuality - 0.12).toFixed(2)));
                setPerfBudget(Math.max(MIN_PERF_BUDGET, +(perfBudget - 0.25).toFixed(2)));
                return;
              }
              setShadowFallback(true);
            }}
            onIncline={() => {
              if (dpr < dprRange.max || cloudQuality < quality.idleCloudQuality || perfBudget < 1) {
                setDpr(Math.min(dprRange.max, +(dpr + 0.1).toFixed(2)));
                setCloudQuality(Math.min(quality.idleCloudQuality, +(cloudQuality + 0.06).toFixed(2)));
                setPerfBudget(Math.min(1, +(perfBudget + 0.12).toFixed(2)));
                return;
              }
              setLeafDensity(Math.min(1, +(leafDensity / 0.8).toFixed(2)));
            }}
          />
        </AfterWarmup>
        <SceneReadySignal onReady={onReady} />
        <SceneRig params={params} fogScale={fogScale} />
        <Sky params={params} />
        <NightSky params={params} />

        {/* Soft fill lights keep the island readable: warm by day, a cool
            moonlit blue at night (the lanterns bring the warmth then). */}
        <hemisphereLight
          intensity={0.36 + night * 0.1}
          color={fillSky}
          groundColor={fillGround}
        />
        <directionalLight
          position={[-14, 12, -10]}
          intensity={0.2 + night * 0.06}
          color={fillKey}
        />

        {/* Weather-driven volumetric clouds. */}
        <VolumetricClouds
          params={params}
          quality={effectiveCloudQuality}
          moving={performanceMoving}
          treeTop={TREE_Y + worldH}
        />
        <Dove interactive={!flying} onFind={onFindDove} moving={performanceMoving} />

        <Float
          speed={performanceMoving ? 0 : 1.1}
          rotationIntensity={performanceMoving ? 0 : 0.1}
          floatIntensity={performanceMoving ? 0 : 0.5}
        >
          {physics && <physics.IslandColliders />}
          <Island
            snow={params.snow}
            scale={ISLAND_SCALE}
            cloudCover={params.cloud}
            windVec={params.windVec}
            aerial={quality.aerial}
            hazeColor={params.fogColor}
          />
          <Plateau
            wind={params.wind}
            gust={params.gust}
            windVec={params.windVec}
            night={night}
            season={params.season}
            cloudCover={params.cloud}
            grassBlades={quality.grassBlades}
            grassTufts={quality.grassTufts}
            budget={ambientBudget}
            moving={performanceMoving}
            aerial={quality.aerial}
            hazeColor={params.fogColor}
          />
          <group position={[0, TREE_Y, 0]} scale={TREE_BOOST}>
            <Tree
              stars={stars}
              wind={params.wind}
              gust={params.gust}
              windVec={params.windVec}
              leafColor={params.leafColor}
              snow={params.snow}
              twilight={params.twilight}
              sunDir={params.sunPos}
              sunColor={params.sunColor}
              sunIntensity={params.sunIntensity}
              wet={params.precip === "rain" ? params.precipIntensity : 0}
              cloudCover={params.cloud}
              forceProxyShadows={shadowFallback}
              leafDensity={leafDensity}
              stargazers={stargazers}
            >
              {withColliders(
                <Houses
                  stars={stars}
                  wind={params.wind}
                  highlight={highlight}
                  focused={focusedHouse}
                  night={night}
                  stargazers={stargazers}
                  interactive={!flying}
                  onSelect={onSelectHouse}
                  moving={performanceMoving}
                />,
              )}
              {withColliders(<Bridges stars={stars} night={night} stargazers={stargazers} />)}
              <Ants
                stars={stars}
                stargazers={stargazers}
                budget={ambientBudget}
                moving={performanceMoving}
              />
              <Birds count={birdCount} stars={stars} moving={performanceMoving} />
            </Tree>
          </group>
        </Float>

        <Weather
          precip={params.precip}
          intensity={params.precipIntensity}
          wind={params.wind}
          gust={params.gust}
          windVec={params.windVec}
          storm={params.storm}
          budget={perfBudget}
          moving={performanceMoving}
          treeTop={TREE_Y + worldH}
          lightDir={params.keyLight.pos}
          cloudLight={params.clouds.baseColor}
          skyTop={params.clouds.shadowColor}
          skyBottom={params.fogColor}
        />
        <Preload all />

        {/* Post stack (bloom, grade, tone mapping, AA). It sleeps while the
            camera moves and ACES stays the single tone-mapping step. */}
        {postEnabled && (
          <EffectComposer enabled={!performanceMoving} multisampling={postprocessingSamples}>
            {postEffects}
          </EffectComposer>
        )}
        <ToneMappingBridge composerAsleep={!postEnabled || performanceMoving} />
        <ShadowThrottle stride={2} />
        <PrewarmShaderVariants />
        <VisibleMatrixUpdates />
        {showStats && <FrameStatsProbe />}
      </Suspense>
      </QualityContext.Provider>

      {/* FOV easing runs in every mode (user-adjustable base FOV from
          Settings); the rotate/tilt part of this driver safely no-ops
          without OrbitControls (state.controls is null in fly/walk). */}
      <CameraRotateDriver />
      {process.env.NODE_ENV !== "production" && <DevHandle />}
      {!flying && (
        <CameraFocusRig
          defaultTarget={orbitTarget}
          focusTarget={focusTarget}
          focusKey={focusedHouse}
        />
      )}
      {camMode === "orbit" ? (
        <OrbitControls
          makeDefault
          target={orbitTarget}
          enablePan={false}
          enableDamping
          dampingFactor={0.055}
          minDistance={12}
          maxDistance={camMax}
          maxPolarAngle={Math.PI / 1.8}
          autoRotate={!uiOverlayOpen}
          autoRotateSpeed={0.35}
          onStart={markCameraMoving}
          onEnd={markCameraSettling}
        />
      ) : camMode === "walk" ? (
        physics && <physics.WalkControls speed={6} stars={stars} onIntroChange={onIntroChange} />
      ) : (
        <CozyFlyControls speed={8} />
      )}
    </>
  );

  return (
    <Canvas
      key={graphicsQuality}
      frameloop="always"
      shadows
      dpr={effectiveDpr}
      // Measure the layout size, not the transformed box: the page scales the
      // scene in by 1.5% while it fades in, and a size taken then would stick
      // (a soft, oversized drawing buffer and slightly offset pointer hits).
      resize={{ offsetSize: true }}
      camera={{ position: [26, 18, 26], fov: DEFAULT_FOV, near: 0.1, far: 600 }}
      gl={{
        antialias: quality.antialias,
        alpha: false,
        powerPreference: "high-performance",
      }}
      performance={{ min: 0.55 }}
      onCreated={({ gl }) => {
        gl.shadowMap.enabled = true;
        gl.shadowMap.type =
          quality.shadowType === "pcfsoft" ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
        // Manual shadow-map updates (see ShadowThrottle): the sun crawls and the
        // shadow casters (trunk, houses, bridges) are static, so re-rendering
        // the whole shadow map every frame is wasted GPU — we refresh it on a
        // stride instead. autoUpdate off + needsUpdate driven per-frame.
        gl.shadowMap.autoUpdate = false;
        gl.shadowMap.needsUpdate = true;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.12;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      {physics ? (
        // Adding the physics world remounts the scene once, the first time walk
        // mode opens.
        <Suspense fallback={null}>
          <physics.PhysicsWorld paused={!inPhysics}>{sceneContent}</physics.PhysicsWorld>
        </Suspense>
      ) : (
        sceneContent
      )}
    </Canvas>
  );
}
