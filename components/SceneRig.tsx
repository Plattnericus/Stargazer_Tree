"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneParams } from "@/lib/weather";
import { useQualityProfile } from "@/lib/quality";

// Owns background, fog and lights, and eases every value toward the target
// SceneParams so weather/time changes fade smoothly instead of snapping.
// fogScale pushes the fog band out as the tree grows: with many stars the
// camera orbits much farther away, and fixed fog distances would wash the
// whole scene out white.
export function SceneRig({
  params,
  fogScale = 1,
}: {
  params: SceneParams;
  fogScale?: number;
}) {
  const scene = useThree((s) => s.scene);
  const quality = useQualityProfile();
  // The shadow frustum must wrap the grown crown too, but growing it costs
  // shadow-map texel density — cap it below the fog reach.
  const shadowScale = Math.min(fogScale, 2);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const dir = useRef<THREE.DirectionalLight>(null);
  const target = useRef({
    bg: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    pos: new THREE.Vector3(),
    sky: new THREE.Color(),
  });

  const cur = useRef({
    bg: new THREE.Color(params.skyColor),
    fog: new THREE.Color(params.fogColor),
    fogNear: params.fogNear,
    fogFar: params.fogFar,
    sun: new THREE.Color(params.sunColor),
    sunI: params.sunIntensity,
    pos: new THREE.Vector3(...params.sunPos),
    hemiI: params.ambient,
    sky: new THREE.Color(params.skyColor),
  });

  if (!scene.background) scene.background = cur.current.bg.clone();
  if (!scene.fog)
    scene.fog = new THREE.Fog(
      cur.current.fog.clone(),
      params.fogNear,
      params.fogFar,
    );

  useFrame((_, dt) => {
    const k = Math.min(1, dt * 1.4);
    const c = cur.current;
    const next = target.current;

    c.bg.lerp(next.bg.set(params.skyColor), k);
    (scene.background as THREE.Color).copy(c.bg);

    const fog = scene.fog as THREE.Fog;
    c.fog.lerp(next.fog.set(params.fogColor), k);
    fog.color.copy(c.fog);
    c.fogNear += (params.fogNear * fogScale - c.fogNear) * k;
    c.fogFar += (params.fogFar * fogScale - c.fogFar) * k;
    fog.near = c.fogNear;
    fog.far = c.fogFar;

    if (dir.current) {
      c.sunI += (params.sunIntensity - c.sunI) * k;
      dir.current.intensity = c.sunI;
      c.sun.lerp(next.sun.set(params.sunColor), k);
      dir.current.color.copy(c.sun);
      // sunPos follows the real sun and dips below the horizon at night; the
      // key light must never shine from underneath, so clamp its height.
      c.pos.lerp(
        next.pos.set(params.sunPos[0], Math.max(params.sunPos[1], 2.5), params.sunPos[2]),
        k,
      );
      dir.current.position.copy(c.pos);
    }
    if (hemi.current) {
      c.hemiI += (params.ambient - c.hemiI) * k;
      hemi.current.intensity = c.hemiI;
      c.sky.lerp(next.sky.set(params.skyColor), k);
      hemi.current.color.copy(c.sky);
    }
  });

  return (
    <>
      <hemisphereLight
        ref={hemi}
        intensity={params.ambient}
        color={params.skyColor}
        groundColor="#4a3828"
      />
      <directionalLight
        ref={dir}
        position={params.sunPos}
        intensity={params.sunIntensity}
        color={params.sunColor}
        castShadow
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-camera-near={1}
        shadow-camera-far={70 * shadowScale}
        shadow-camera-left={-18 * shadowScale}
        shadow-camera-right={18 * shadowScale}
        shadow-camera-top={30 * shadowScale}
        shadow-camera-bottom={-16 * shadowScale}
        shadow-radius={7}
        shadow-bias={quality.leafShadows === "real" ? -0.0005 : -0.00035}
        shadow-normalBias={quality.leafShadows === "real" ? 0.05 : 0.035}
        shadow-intensity={0.94}
      />
    </>
  );
}
