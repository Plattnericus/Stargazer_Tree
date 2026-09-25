"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useQualityProfile } from "@/lib/quality";
import type { SceneParams } from "@/lib/weather";

const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vPhase;
  varying float vAltitude;
  uniform float uIntensity;
  void main() {
    vColor = color;
    vPhase = aPhase;
    vAltitude = normalize(position).y;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (220.0 / max(1.0, -mvPosition.z)) * (0.25 + uIntensity * 0.75);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vPhase;
  varying float vAltitude;
  uniform float uTime;
  uniform float uIntensity;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = dot(p, p);
    if (d > 0.25) discard;
    float core = smoothstep(0.25, 0.015, d);
    // Real atmospheric extinction: stars dim (and twinkle harder) near the
    // horizon where their light crosses much more air.
    float extinction = mix(0.18, 1.0, smoothstep(-0.02, 0.24, vAltitude));
    float lowFlicker = 1.0 + (1.0 - smoothstep(0.0, 0.3, vAltitude)) * 0.5;
    float twinkle = 0.76 + 0.24 * sin(uTime * (0.7 + fract(vPhase) * 1.6) * lowFlicker + vPhase * 19.17);
    gl_FragColor = vec4(vColor * (0.82 + twinkle * 0.3), core * uIntensity * twinkle * extinction);
#include <tonemapping_fragment>
#include <colorspace_fragment>
  }
`;

const MOON_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MOON_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uIntensity;
  uniform vec3 uLightDir; // toward the sun, in billboard-local space
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform float uWarm; // 1 near the horizon: reddened + dimmed like a real moonrise

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 hash2(vec2 p) {
    return vec2(hash(p), hash(p + 17.13));
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 5; i++) {
      v += noise(p) * a;
      p = p * 2.08 + vec2(8.31, 4.77);
      a *= 0.48;
    }
    return v;
  }

  float craterField(vec2 p) {
    vec2 g = p * 7.0;
    vec2 cell = floor(g);
    vec2 local = fract(g);
    float c = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 off = vec2(float(x), float(y));
        vec2 seed = cell + off;
        vec2 center = hash2(seed);
        float radius = mix(0.12, 0.32, hash(seed + 9.4));
        float d = length(local - off - center);
        float bowl = smoothstep(radius, 0.0, d) * 0.32;
        float rim = smoothstep(radius * 1.18, radius * 0.93, d) * smoothstep(radius * 0.66, radius * 0.92, d);
        c += rim * 0.28 - bowl;
      }
    }
    return c;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.55;
    float r = length(p);
    float halo = (1.0 - smoothstep(0.98, 1.32, r)) * smoothstep(0.72, 1.08, r);
    if (r > 1.32) discard;

    if (r > 1.0) {
      gl_FragColor = vec4(vec3(0.74, 0.82, 1.0), halo * uIntensity * 0.18);
#include <tonemapping_fragment>
#include <colorspace_fragment>
      return;
    }

    // Shade a virtual sphere behind the billboard with the REAL sun direction:
    // phase fraction and lit-limb orientation fall out of the geometry.
    vec3 normal = normalize(vec3(p.xy, sqrt(max(0.001, 1.0 - r * r))));
    vec3 lightDir = normalize(uLightDir);
    float lit = smoothstep(-0.05, 0.12, dot(normal, lightDir));
    float limb = smoothstep(1.0, 0.32, r);

    vec3 albedo;
    if (uHasMap > 0.5) {
      // Near-side equirectangular sampling (LROC map is centered on lon 0).
      vec2 uv = vec2(
        0.5 + atan(normal.x, normal.z) / 6.28318530718,
        0.5 + asin(clamp(normal.y, -1.0, 1.0)) / 3.14159265359
      );
      albedo = texture2D(uMap, uv).rgb * 1.6;
    } else {
      float terrain = fbm(p * 3.0);
      float fine = fbm(p * 15.0);
      float craters = craterField(p);
      float maria = smoothstep(0.54, 0.86, fbm(p * 2.0 + 4.2));
      albedo = mix(vec3(0.68, 0.70, 0.67), vec3(0.93, 0.91, 0.82), terrain * 0.7 + fine * 0.18);
      albedo = mix(albedo, vec3(0.43, 0.45, 0.46), maria * 0.32);
      albedo += craters * vec3(0.58, 0.56, 0.5);
    }

    // Atmospheric reddening near the horizon (real moonrise look): the short
    // wavelengths scatter away, the disc dims.
    albedo *= mix(vec3(1.0), vec3(1.04, 0.6, 0.36), uWarm * 0.8);
    float extinction = mix(1.0, 0.55, uWarm);

    vec3 sunlit = albedo * (0.3 + limb * 0.82) * lit * extinction;
    // Faint, slightly blue earthshine keeps the dark side barely readable.
    vec3 earthshine = albedo * vec3(0.36, 0.43, 0.58) * 0.09 * (1.0 - lit) * extinction;
    float alpha = (1.0 - smoothstep(0.965, 1.0, r)) * uIntensity * clamp(0.08 + lit * 0.92, 0.0, 1.0);
    gl_FragColor = vec4(sunlit + earthshine, alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
  }
`;

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function StarField({ params }: { params: SceneParams }) {
  const points = useRef<THREE.Points>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const count = useQualityProfile().stars;
  const geometry = useMemo(() => {
    const rand = seeded(40429);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const color = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const band = rand() < 0.38;
      const theta = rand() * Math.PI * 2;
      const y = band
        ? THREE.MathUtils.clamp((rand() - 0.5) * 0.28 + Math.sin(theta * 1.7) * 0.1, -0.08, 0.92)
        : Math.pow(rand(), 0.42) * 1.08 - 0.08;
      const r = Math.sqrt(Math.max(0.001, 1 - y * y));
      const radius = 96;
      positions[i * 3] = Math.cos(theta) * r * radius;
      positions[i * 3 + 1] = y * radius;
      positions[i * 3 + 2] = Math.sin(theta) * r * radius;

      const temp = rand();
      color.set(temp < 0.18 ? "#bcd7ff" : temp > 0.82 ? "#ffe0b8" : "#f6f4ea");
      const bright = Math.pow(rand(), 2.1);
      colors[i * 3] = color.r * (0.58 + bright * 0.7);
      colors[i * 3 + 1] = color.g * (0.58 + bright * 0.7);
      colors[i * 3 + 2] = color.b * (0.58 + bright * 0.7);
      sizes[i] = 1.05 + bright * 2.3;
      phases[i] = rand() * 1000;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    return g;
  }, [count]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 0 },
    }),
    [],
  );

  useFrame((state, dt) => {
    const m = material.current;
    if (!m) return;
    m.uniforms.uTime.value = state.clock.elapsedTime;
    m.uniforms.uIntensity.value += (params.starsIntensity - m.uniforms.uIntensity.value) * Math.min(1, dt * 1.25);
    // Skip the draw entirely by day instead of blending hundreds of
    // fully transparent points.
    if (points.current) points.current.visible = m.uniforms.uIntensity.value > 0.004;
  });

  return (
    <points ref={points} geometry={geometry} renderOrder={-8} frustumCulled={false}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={STAR_VERTEX}
        fragmentShader={STAR_FRAGMENT}
        vertexColors
        transparent
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Moon({ params }: { params: SceneParams }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const { camera } = useThree();
  const sunDir = useMemo(() => new THREE.Vector3(), []);
  const invQuat = useMemo(() => new THREE.Quaternion(), []);
  const uniforms = useMemo(
    () => ({
      uIntensity: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) },
      uMap: { value: null as THREE.Texture | null },
      uHasMap: { value: 0 },
      uWarm: { value: 0 },
    }),
    [],
  );

  // Real NASA LROC albedo map (public domain); the procedural surface in the
  // shader stays as fallback if the texture is missing or fails to load.
  useEffect(() => {
    let disposed = false;
    new THREE.TextureLoader().load(
      "/textures/moon_albedo_1k.jpg",
      (tex) => {
        if (disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        uniforms.uMap.value = tex;
        uniforms.uHasMap.value = 1;
      },
      undefined,
      () => undefined,
    );
    return () => {
      disposed = true;
      uniforms.uMap.value?.dispose();
      uniforms.uMap.value = null;
      uniforms.uHasMap.value = 0;
    };
  }, [uniforms]);

  useFrame((_, dt) => {
    const current = mesh.current;
    const m = material.current;
    if (!current || !m) return;
    // World-space sky position: the parent group follows only the camera's
    // POSITION, so the moon keeps its real place while the camera orbits.
    current.position.set(params.moon.pos[0], params.moon.pos[1], params.moon.pos[2]);
    current.scale.setScalar(params.moon.size);
    current.quaternion.copy(camera.quaternion); // billboard facing only
    // Light the disc from the actual sun direction, expressed in the
    // billboard's camera-aligned local frame -> real phase + limb tilt.
    sunDir.set(params.sunPos[0], params.sunPos[1], params.sunPos[2]).normalize();
    invQuat.copy(camera.quaternion).invert();
    sunDir.applyQuaternion(invQuat);
    (m.uniforms.uLightDir.value as THREE.Vector3).copy(sunDir);
    m.uniforms.uIntensity.value += (params.moon.visible - m.uniforms.uIntensity.value) * Math.min(1, dt * 1.2);
    // Low moon -> atmospheric reddening (moon dir y over the 88-unit radius).
    const altitude = params.moon.pos[1] / 88;
    const warm = 1 - THREE.MathUtils.smoothstep(altitude, 0.05, 0.3);
    m.uniforms.uWarm.value += (warm - m.uniforms.uWarm.value) * Math.min(1, dt * 1.5);
    current.visible = m.uniforms.uIntensity.value > 0.004;
  });

  return (
    <mesh ref={mesh} renderOrder={-5} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={MOON_VERTEX}
        fragmentShader={MOON_FRAGMENT}
        transparent
        depthWrite={false}
        depthTest
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function NightSky({ params }: { params: SceneParams }) {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    group.current?.position.copy(camera.position);
  });

  // Moonlight itself is the scene's key light at night (SceneRig), so it
  // casts real shadows and costs no extra light in every shader.
  return (
    <group ref={group} renderOrder={-10}>
      <StarField params={params} />
      <Moon params={params} />
    </group>
  );
}
