"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Precip } from "@/lib/weather";
import { useQualityProfile } from "@/lib/quality";

const AREA = 34; // half-extent in X/Z
const TOP = 46;

// Snow — soft drifting points. Fixed-size buffer + draw range so changing the
// intensity never resizes a GPU attribute (three.js forbids that); the buffer
// itself is sized by the quality tier and only re-allocates when that changes.
function Snow({
  intensity,
  wind,
  gust,
  windVec,
  max,
}: {
  intensity: number;
  wind: number;
  gust: number;
  windVec: [number, number];
  max: number;
}) {
  const ref = useRef<THREE.Points>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const count = Math.max(1, Math.floor(max * intensity));

  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(max * 3);
    const speeds = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      positions[i * 3] = (Math.random() - 0.5) * AREA * 2;
      positions[i * 3 + 1] = Math.random() * TOP;
      positions[i * 3 + 2] = (Math.random() - 0.5) * AREA * 2;
      speeds[i] = 1.4 * (0.7 + Math.random() * 0.6);
    }
    return { positions, speeds };
  }, [max]);

  useFrame((state) => {
    const pts = ref.current;
    const mat = material.current;
    if (!pts || !mat) return;
    pts.geometry.setDrawRange(0, count);
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uFlow.value = wind + gust * 0.28;
    mat.uniforms.uWindDir.value.set(windVec[0], windVec[1]).normalize();
    mat.uniforms.uOpacity.value = 0.95;
  });

  return (
    <points ref={ref}>
      <bufferGeometry key={max}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSpeed" args={[speeds, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={material}
        transparent
        depthWrite={false}
        uniforms={{
          uTime: { value: 0 },
          uFlow: { value: 0 },
          uWindDir: { value: new THREE.Vector2(windVec[0], windVec[1]) },
          uOpacity: { value: 0.95 },
        }}
        vertexShader={/* glsl */ `
          uniform float uTime;
          uniform float uFlow;
          uniform vec2 uWindDir;
          attribute float aSpeed;
          varying float vAlpha;
          const float AREA = ${AREA.toFixed(1)};
          const float TOP = ${TOP.toFixed(1)};
          void main() {
            vec2 wind = normalize(uWindDir);
            vec2 side = vec2(-wind.y, wind.x);
            float span = TOP + 10.0;
            float y = mod(position.y + 10.0 - uTime * aSpeed, span) - 10.0;
            float swirl = sin(uTime + position.x * 0.37 + position.z * 0.23) * 0.35;
            vec2 xz = position.xz + wind * uFlow * uTime * 1.2 + side * swirl;
            xz = mod(xz + AREA, AREA * 2.0) - AREA;
            vec4 mv = modelViewMatrix * vec4(xz.x, y, xz.y, 1.0);
            gl_PointSize = 0.32 * (110.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
            vAlpha = smoothstep(-10.0, -6.0, y) * smoothstep(TOP, TOP - 6.0, y);
          }
        `}
        fragmentShader={/* glsl */ `
          uniform float uOpacity;
          varying float vAlpha;
          void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float d = length(uv);
            if (d > 0.5) discard;
            float soft = smoothstep(0.5, 0.08, d);
            gl_FragColor = vec4(vec3(1.0), soft * vAlpha * uOpacity);
          }
        `}
      />
    </points>
  );
}

// Rain — falling streaks (two verts per drop) slanted by the wind. Heavier and
// faster than snow; opacity/length scale up toward a storm.
function Rain({
  intensity,
  wind,
  gust,
  windVec,
  max,
}: {
  intensity: number;
  wind: number;
  gust: number;
  windVec: [number, number];
  max: number;
}) {
  const ref = useRef<THREE.LineSegments>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const count = Math.max(1, Math.floor(max * Math.max(0.35, intensity)));
  const len = 1.1 + intensity * 1.6; // streak length
  const slant = THREE.MathUtils.clamp((wind + gust * 0.32) * 0.5, 0, 2.4);

  const { positions, speeds, tails } = useMemo(() => {
    const positions = new Float32Array(max * 6);
    const speeds = new Float32Array(max * 2);
    const tails = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) {
      const x = (Math.random() - 0.5) * AREA * 2;
      const y = Math.random() * TOP;
      const z = (Math.random() - 0.5) * AREA * 2;
      const speed = 26 * (0.75 + Math.random() * 0.5);
      positions[i * 6] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = z;
      speeds[i * 2] = speed;
      speeds[i * 2 + 1] = speed;
      tails[i * 2] = 0;
      tails[i * 2 + 1] = 1;
    }
    return { positions, speeds, tails };
  }, [max]);

  useFrame((state) => {
    const seg = ref.current;
    const mat = material.current;
    if (!seg || !mat) return;
    seg.geometry.setDrawRange(0, count * 2);
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uFlow.value = wind + gust * 0.32;
    mat.uniforms.uWindDir.value.set(windVec[0], windVec[1]).normalize();
    mat.uniforms.uLength.value = len;
    mat.uniforms.uSlant.value = slant;
    mat.uniforms.uOpacity.value = 0.34 + intensity * 0.3;
  });

  return (
    <lineSegments ref={ref}>
      <bufferGeometry key={max}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSpeed" args={[speeds, 1]} />
        <bufferAttribute attach="attributes-aTail" args={[tails, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={material}
        transparent
        depthWrite={false}
        uniforms={{
          uTime: { value: 0 },
          uFlow: { value: 0 },
          uWindDir: { value: new THREE.Vector2(windVec[0], windVec[1]) },
          uLength: { value: len },
          uSlant: { value: slant },
          uOpacity: { value: 0.34 + intensity * 0.3 },
          uColor: { value: new THREE.Color("#9fc2e8") },
        }}
        vertexShader={/* glsl */ `
          uniform float uTime;
          uniform float uFlow;
          uniform vec2 uWindDir;
          uniform float uLength;
          uniform float uSlant;
          attribute float aSpeed;
          attribute float aTail;
          varying float vAlpha;
          const float AREA = ${AREA.toFixed(1)};
          const float TOP = ${TOP.toFixed(1)};
          void main() {
            vec2 wind = normalize(uWindDir);
            float span = TOP + 8.0;
            float y = mod(position.y + 8.0 - uTime * aSpeed, span) - 8.0;
            vec2 xz = position.xz + wind * uFlow * uTime * 3.2;
            xz = mod(xz + AREA, AREA * 2.0) - AREA;
            vec2 slant = wind * uSlant * uLength * 0.4;
            vec3 p = vec3(xz.x, y, xz.y) - vec3(slant.x, uLength, slant.y) * aTail;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
            vAlpha = smoothstep(-8.0, -4.0, y) * smoothstep(TOP, TOP - 7.0, y);
          }
        `}
        fragmentShader={/* glsl */ `
          uniform float uOpacity;
          uniform vec3 uColor;
          varying float vAlpha;
          void main() {
            gl_FragColor = vec4(uColor, uOpacity * vAlpha);
          }
        `}
      />
    </lineSegments>
  );
}

// One puffy cartoon cloud cluster = a few overlapping flattened spheres.
function makePuffGeometry(seed: number) {
  const rng = (() => {
    let s = seed * 9973;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  })();
  const geos: THREE.BufferGeometry[] = [];
  const puffs = 5 + Math.floor(rng() * 3);
  for (let i = 0; i < puffs; i++) {
    const r = 2.4 + rng() * 2.2;
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.translate((rng() - 0.5) * 9, (rng() - 0.5) * 1.6, (rng() - 0.5) * 5);
    g.scale(1, 0.7, 1);
    geos.push(g);
  }
  // simple concat merge (position only) then recompute normals for flat shading
  let total = 0;
  geos.forEach((g) => (total += (g.getAttribute("position").array as Float32Array).length));
  const pos = new Float32Array(total);
  let off = 0;
  geos.forEach((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    const a = ng.getAttribute("position").array as Float32Array;
    pos.set(a, off);
    off += a.length;
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, off), 3));
  merged.computeVertexNormals();
  return merged;
}

// Dark storm clouds that roll in (cartoon scale-pop + drift) whenever it rains,
// and flash from within when lightning strikes (driven by `flashRef`).
function StormClouds({
  active,
  flashRef,
  wind,
  gust,
  windVec,
  moving = false,
}: {
  active: boolean;
  flashRef: React.MutableRefObject<number>;
  wind: number;
  gust: number;
  windVec: [number, number];
  moving?: boolean;
}) {
  const layout = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => {
        const ang = (i / 6) * Math.PI * 2 + 0.4;
        const rad = 16 + (i % 3) * 5;
        return {
          geo: makePuffGeometry(i + 1),
          pos: [Math.cos(ang) * rad, 26 + (i % 2) * 4, Math.sin(ang) * rad] as [number, number, number],
          phase: i * 1.3,
          drift: 0.5 + (i % 3) * 0.2,
        };
      }),
    [],
  );
  const groups = useRef<(THREE.Group | null)[]>([]);
  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#5b636e",
        roughness: 1,
        metalness: 0,
        flatShading: true,
        emissive: new THREE.Color("#eaf2ff"),
        emissiveIntensity: 0,
      }),
    [],
  );
  const frameSkip = useRef(0);
  const dtAcc = useRef(0);

  useFrame((state, dt) => {
    if (moving) {
      dtAcc.current += dt;
      frameSkip.current = (frameSkip.current + 1) % 2;
      if (frameSkip.current !== 0) return;
      dt = dtAcc.current;
      dtAcc.current = 0;
    } else {
      dtAcc.current = 0;
      frameSkip.current = 0;
    }
    const t = state.clock.elapsedTime;
    mat.emissiveIntensity = flashRef.current * 1.6;
    for (let i = 0; i < layout.length; i++) {
      const g = groups.current[i];
      if (!g) continue;
      const target = active ? 1 : 0;
      const s = g.scale.x + (target - g.scale.x) * Math.min(1, dt * 3);
      g.scale.setScalar(s);
      // Parked clouds (no rain) are not drawn at all.
      g.visible = s > 0.01;
      const l = layout[i];
      const drift = Math.sin(t * 0.07 * l.drift + l.phase) * (3 + wind * 0.7 + gust * 0.35);
      const cross = Math.cos(t * 0.052 * l.drift + l.phase) * 1.5;
      const sx = -windVec[1];
      const sz = windVec[0];
      g.position.x = l.pos[0] + windVec[0] * drift + sx * cross;
      g.position.y = l.pos[1] + Math.sin(t * 0.4 + l.phase) * 0.6;
      g.position.z = l.pos[2] + windVec[1] * drift + sz * cross;
    }
  });

  return (
    <group>
      {layout.map((l, i) => (
        <group
          key={i}
          ref={(g) => {
            groups.current[i] = g;
          }}
          position={l.pos}
          scale={0.001}
          visible={false}
        >
          <mesh geometry={l.geo} material={mat} />
        </group>
      ))}
    </group>
  );
}

// Lightning — a bright flash (sky-wide light), a glowing forked bolt, and a
// short after-flicker, fired at random intervals during a storm.
// Always mounted (lights included) — unmounting a light forces a full scene
// shader recompile. `active` gates the strikes instead.
function Lightning({
  flashRef,
  active,
  moving = false,
}: {
  flashRef: React.MutableRefObject<number>;
  active: boolean;
  moving?: boolean;
}) {
  const light = useRef<THREE.PointLight>(null);
  const ambient = useRef<THREE.AmbientLight>(null);
  const bolt = useRef<THREE.LineSegments>(null);
  const next = useRef(1.5);
  const flicker = useRef(0);
  const frameSkip = useRef(0);
  const dtAcc = useRef(0);

  const SEGMENTS = 14;
  const positions = useMemo(() => new Float32Array(SEGMENTS * 2 * 3), []);

  const strike = (originX: number, originZ: number) => {
    const arr = positions;
    let x = originX;
    let y = 34;
    const z = originZ;
    for (let i = 0; i < SEGMENTS; i++) {
      const nx = x + (Math.random() - 0.5) * 3.2;
      const ny = y - (34 - 6) / SEGMENTS;
      arr[i * 6] = x;
      arr[i * 6 + 1] = y;
      arr[i * 6 + 2] = z;
      arr[i * 6 + 3] = nx;
      arr[i * 6 + 4] = ny;
      arr[i * 6 + 5] = z + (Math.random() - 0.5) * 2;
      x = nx;
      y = ny;
    }
    if (bolt.current) {
      bolt.current.geometry.attributes.position.needsUpdate = true;
      bolt.current.position.x = 0;
    }
    if (light.current) light.current.position.set(originX, 30, originZ);
  };

  useFrame((state, dt) => {
    if (moving) {
      dtAcc.current += dt;
      frameSkip.current = (frameSkip.current + 1) % 2;
      if (frameSkip.current !== 0) return;
      dt = dtAcc.current;
      dtAcc.current = 0;
    } else {
      dtAcc.current = 0;
      frameSkip.current = 0;
    }
    const t = state.clock.elapsedTime;
    if (!active) {
      next.current = t + 1.5;
      flashRef.current = 0;
      if (light.current) light.current.intensity = 0;
      if (ambient.current) ambient.current.intensity = 0;
      if (bolt.current) bolt.current.visible = false;
      return;
    }
    if (t > next.current) {
      // a strike: main flash + scheduled flicker, then a long-ish gap
      strike((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40);
      flashRef.current = 1;
      flicker.current = 2;
      next.current = t + 2.6 + Math.random() * 5;
    } else if (flicker.current > 0 && flashRef.current < 0.12) {
      // quick secondary flashes that real lightning has
      flashRef.current = 0.8;
      flicker.current -= 1;
    }
    // decay the flash
    flashRef.current = Math.max(0, flashRef.current - dt * 4.5);
    const f = flashRef.current;
    if (light.current) light.current.intensity = f * 900;
    if (ambient.current) ambient.current.intensity = f * 1.4;
    const m = bolt.current?.material as THREE.LineBasicMaterial | undefined;
    if (m) m.opacity = f > 0.5 ? 1 : 0;
    if (bolt.current) bolt.current.visible = f > 0.5;
  });

  return (
    <group>
      <pointLight ref={light} color="#dbe7ff" intensity={0} distance={140} decay={1.4} />
      <ambientLight ref={ambient} color="#cfe0ff" intensity={0} />
      <lineSegments ref={bolt} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          color="#f4f8ff"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>
    </group>
  );
}

// Top-level weather: precipitation + (for rain) rolling storm clouds and, when
// it's a thunderstorm, lightning. Snow keeps its gentle drift.
export function Weather({
  precip,
  intensity,
  wind,
  gust = 0,
  windVec = [1, 0],
  storm = false,
  budget = 1,
  moving = false,
}: {
  precip: Precip;
  intensity: number;
  wind: number;
  gust?: number;
  windVec?: [number, number];
  storm?: boolean;
  /** 0..1 PerformanceMonitor budget — scales particle counts under load. */
  budget?: number;
  moving?: boolean;
}) {
  const flashRef = useRef(0);
  const profile = useQualityProfile();
  const isRain = precip === "rain";
  const rainMax = Math.max(80, Math.round(profile.rainMax * budget));
  const snowMax = Math.max(60, Math.round(profile.snowMax * budget));

  return (
    <>
      {precip === "snow" && <Snow intensity={intensity} wind={wind} gust={gust} windVec={windVec} max={snowMax} />}
      {isRain && <Rain intensity={intensity} wind={wind} gust={gust} windVec={windVec} max={rainMax} />}
      <StormClouds active={isRain} flashRef={flashRef} wind={wind} gust={gust} windVec={windVec} moving={moving} />
      <Lightning flashRef={flashRef} active={storm} moving={moving} />
    </>
  );
}
