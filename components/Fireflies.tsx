"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Drifting, pulsing fireflies — GPU-animated points (one draw call). They float
 * around the island/canopy volume, glow warm, and come alive at night.
 */
export function Fireflies({
  count = 45,
  maxCount = count,
  radius = 11,
  baseY = 5.5,
  height = 9,
  night = 0,
}: {
  count?: number;
  /** Buffer size; `count` can then change (performance budget) without
   *  reallocating or reshuffling the swarm. */
  maxCount?: number;
  radius?: number;
  baseY?: number;
  height?: number;
  night?: number;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const capacity = Math.max(count, maxCount);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(capacity * 3);
    const seed = new Float32Array(capacity * 3);
    const phase = new Float32Array(capacity);
    const tint = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const r = radius * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = baseY + Math.random() * height;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i * 3] = 0.4 + Math.random() * 0.8;
      seed[i * 3 + 1] = 0.3 + Math.random() * 0.7;
      seed[i * 3 + 2] = 0.4 + Math.random() * 0.8;
      phase[i] = Math.random() * Math.PI * 2;
      tint[i] = Math.random();
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 3));
    g.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    g.setAttribute("aTint", new THREE.BufferAttribute(tint, 1));
    g.computeBoundingSphere();
    return g;
  }, [capacity, radius, baseY, height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  geometry.setDrawRange(0, Math.min(count, capacity));

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0.1 },
          uSize: { value: 7 },
          uColorA: { value: new THREE.Color("#fff3a0") },
          uColorB: { value: new THREE.Color("#bdf57a") },
        },
        vertexShader: `
          uniform float uTime;
          uniform float uSize;
          attribute vec3 aSeed;
          attribute float aPhase;
          attribute float aTint;
          varying float vPulse;
          varying float vTint;
          void main() {
            vTint = aTint;
            vec3 p = position;
            p.x += sin(uTime * aSeed.x + aPhase) * 0.6;
            p.y += sin(uTime * aSeed.y * 0.7 + aPhase) * 0.4
                 + sin(uTime * 0.2 + aPhase) * 0.2;
            p.z += cos(uTime * aSeed.z + aPhase * 1.3) * 0.6;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float pulse = pow(sin(uTime * 2.0 * aSeed.x + aPhase) * 0.5 + 0.5, 2.0);
            vPulse = 0.2 + 0.8 * pulse;
            gl_PointSize = uSize * vPulse * (110.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform float uIntensity;
          uniform vec3 uColorA;
          uniform vec3 uColorB;
          varying float vPulse;
          varying float vTint;
          void main() {
            vec2 uv = gl_PointCoord - 0.5;
            float d = length(uv);
            if (d > 0.5) discard;
            float core = smoothstep(0.5, 0.0, d);
            float glow = pow(core, 2.0);
            vec3 col = mix(uColorA, uColorB, vTint);
            float alpha = glow * vPulse * uIntensity;
            gl_FragColor = vec4(col * (0.6 + glow), alpha);
#include <tonemapping_fragment>
#include <colorspace_fragment>
          }
        `,
      }),
    [],
  );

  useFrame((state) => {
    if (!matRef.current) return;
    matRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    // barely-there by day, gently glowing at night
    const target = 0.05 + night * 0.4;
    const u = matRef.current.uniforms.uIntensity;
    u.value += (target - u.value) * 0.05;
  });

  return (
    <points geometry={geometry}>
      <primitive object={material} ref={matRef} attach="material" />
    </points>
  );
}
