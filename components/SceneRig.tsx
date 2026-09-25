"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneParams } from "@/lib/weather";
import { useQualityProfile } from "@/lib/quality";
import { fogAntiColor, fogSunColor, fogSunDir } from "@/lib/fog";

// Sun and moon dip below the horizon; the key light must never shine from
// underneath, so its height is clamped. It's placed at the sun's distance
// (40) so a moon key light keeps the same shadow-camera framing.
function keyLightPosition(p: [number, number, number], out: THREE.Vector3): THREE.Vector3 {
  const flat = Math.hypot(p[0], p[2]);
  const height = Math.max(p[1] / (Math.hypot(flat, p[1]) || 1), 0.0625);
  const side = Math.sqrt(1 - height * height) / (flat || 1);
  return out.set(flat ? p[0] * side : 0, height, flat ? p[2] * side : 0).multiplyScalar(40);
}

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
    fogSun: new THREE.Color(),
    fogAnti: new THREE.Color(),
    sunFlat: new THREE.Vector3(),
    sun: new THREE.Color(),
    pos: new THREE.Vector3(),
    sky: new THREE.Color(),
  });

  const cur = useRef({
    bg: new THREE.Color(params.skyColor),
    fog: new THREE.Color(params.fogColor),
    fogSun: new THREE.Color(params.fogSunColor),
    fogAnti: new THREE.Color(params.fogAntiColor),
    sunFlat: new THREE.Vector3(params.sunPos[0], 0, params.sunPos[2]).normalize(),
    fogNear: params.fogNear,
    fogFar: params.fogFar,
    sun: new THREE.Color(params.keyLight.color),
    sunI: params.keyLight.intensity,
    pos: keyLightPosition(params.keyLight.pos, new THREE.Vector3()),
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
    // Directional part of the fog (lib/fog.ts): horizon colors toward and
    // away from the sun, shared by every material.
    c.fogSun.lerp(next.fogSun.set(params.fogSunColor), k);
    c.fogAnti.lerp(next.fogAnti.set(params.fogAntiColor), k);
    next.sunFlat.set(params.sunPos[0], 0, params.sunPos[2]);
    if (next.sunFlat.lengthSq() < 1e-6) next.sunFlat.set(1, 0, 0);
    c.sunFlat.lerp(next.sunFlat.normalize(), k).normalize();
    c.sunFlat.toArray(fogSunDir);
    c.fogSun.toArray(fogSunColor);
    c.fogAnti.toArray(fogAntiColor);

    if (dir.current) {
      // Key light: the sun by day, the moon by night (see keyLight in
      // lib/weather.ts). The swap happens while both are dim.
      const key = params.keyLight;
      c.sunI += (key.intensity - c.sunI) * k;
      dir.current.intensity = c.sunI;
      c.sun.lerp(next.sun.set(key.color), k);
      dir.current.color.copy(c.sun);
      c.pos.lerp(keyLightPosition(key.pos, next.pos), k);
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
        position={params.keyLight.pos}
        intensity={params.keyLight.intensity}
        color={params.keyLight.color}
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
