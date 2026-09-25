"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { SurfaceProfile } from "@/lib/surface";
import { AERIAL_FRAG, CLOUD_SHADOW_FRAG } from "@/lib/shaderChunks";

const GRASS = "/models/grass.glb";
const TMP = new THREE.Object3D();

// grass.glb is meshopt-compressed, so its attributes are quantized integers
// (often interleaved). Baking a transform into those would clamp them, so
// expand every attribute to plain floats before touching the geometry.
function toFloatAttributes(geo: THREE.BufferGeometry) {
  for (const name of Object.keys(geo.attributes)) {
    const src = geo.getAttribute(name);
    if (src instanceof THREE.BufferAttribute && src.array instanceof Float32Array) continue;
    const size = src.itemSize;
    const out = new Float32Array(src.count * size);
    for (let i = 0; i < src.count; i++) {
      for (let c = 0; c < size; c++) out[i * size + c] = src.getComponent(i, c);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
}

// Seeded RNG so the meadow is identical every reload.
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Detailed hand-painted grass tufts (grass.glb, 4 brush layers). Each layer is
 * its own InstancedMesh sharing the same per-tuft transforms, so the whole
 * field is 4 draw calls. A vertex shader bends the blades in the wind.
 * grass.glb is not preloaded: this component is only mounted on quality tiers
 * that draw tufts, so the other tiers never download it.
 */
export function GrassClumps({
  count = 18,
  radius = 8,
  topY = 5.2,
  wind = 1,
  gust = 0,
  windVec = [1, 0],
  cloudCover = 0,
  surface,
  aerial = 0,
  hazeColor = "#a8c4de",
}: {
  count?: number;
  radius?: number;
  topY?: number;
  wind?: number;
  gust?: number;
  windVec?: [number, number];
  cloudCover?: number;
  surface?: SurfaceProfile;
  aerial?: number;
  hazeColor?: string;
}) {
  const { scene } = useGLTF(GRASS);
  const uniforms = useRef({
    uTime: { value: 0 },
    uWind: { value: wind },
    uWindDir: { value: new THREE.Vector2(windVec[0], windVec[1]) },
    uCloudCover: { value: cloudCover },
    uAerial: { value: aerial },
    uHazeColor: { value: new THREE.Color(hazeColor) },
  });

  // Normalise every brush layer to a unit-height tuft with its base at y=0,
  // centred in x/z, and wire the wind-sway shader into each material.
  const parts = useMemo(() => {
    const src = scene.clone(true);
    src.updateMatrixWorld(true);
    const out: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
    const box = new THREE.Box3();
    src.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const g = o.geometry.clone();
        toFloatAttributes(g);
        g.applyMatrix4(o.matrixWorld);
        g.computeBoundingBox();
        box.union(g.boundingBox!);
        out.push({ geo: g, mat: (o.material as THREE.Material).clone() });
      }
    });
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const H = size.y || 1;
    out.forEach(({ geo, mat }) => {
      geo.translate(-center.x, -box.min.y, -center.z);
      geo.scale(1 / H, 1 / H, 1 / H);
      const m = mat as THREE.MeshStandardMaterial;
      m.side = THREE.DoubleSide;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = uniforms.current.uTime;
        shader.uniforms.uWind = uniforms.current.uWind;
        shader.uniforms.uWindDir = uniforms.current.uWindDir;
        shader.uniforms.uCloudCover = uniforms.current.uCloudCover;
        shader.uniforms.uAerial = uniforms.current.uAerial;
        shader.uniforms.uHazeColor = uniforms.current.uHazeColor;
        shader.vertexShader =
          "uniform float uTime;\nuniform float uWind;\nuniform vec2 uWindDir;\nvarying vec3 vWPos;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
             float sway = max(position.y, 0.0);
             vec4 wp = instanceMatrix * vec4(0.0,0.0,0.0,1.0);
             vec2 dir = normalize(uWindDir);
             vec2 side = vec2(-dir.y, dir.x);
             float ph = wp.x * 0.5 + wp.z * 0.4;
             float gust = 0.76 + 0.22 * sin(uTime * 0.42 + ph);
             float downwind = sway * (0.08 + sin(uTime * 1.1 + ph) * 0.055) * uWind * gust;
             float lateral = sway * cos(uTime * 1.65 + ph * 1.7) * 0.035 * uWind;
             transformed.x += dir.x * downwind + side.x * lateral;
             transformed.z += dir.y * downwind + side.y * lateral;
             vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`,
          );
        shader.fragmentShader =
          "uniform float uTime;\nuniform vec2 uWindDir;\nuniform float uCloudCover;\nuniform float uAerial;\nuniform vec3 uHazeColor;\nvarying vec3 vWPos;\n" +
          shader.fragmentShader.replace(
            "#include <color_fragment>",
            `#include <color_fragment>\n${CLOUD_SHADOW_FRAG}\n${AERIAL_FRAG}`,
          );
      };
      m.needsUpdate = true;
    });
    return out;
  }, [scene]);

  // Shared per-tuft transforms (dome-following, denser toward mid-field, kept
  // clear of the trunk at the centre).
  const matrices = useMemo(() => {
    const rng = mulberry(1337);
    const arr: THREE.Matrix4[] = [];
    const R = surface ? surface.edgeR * 0.97 : radius;
    for (let i = 0; i < count; i++) {
      const r = 2.2 + (R - 2.2) * Math.sqrt(rng());
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = surface
        ? surface.heightAt(r) - 0.05
        : topY - Math.pow(r / radius, 2) * 1.6 - 0.05;
      const h = 1.1 + rng() * 1.2;
      const w = 0.95 + rng() * 0.8;
      TMP.position.set(x, y, z);
      TMP.rotation.set(0, rng() * Math.PI * 2, 0);
      TMP.scale.set(w, h, w);
      TMP.updateMatrix();
      arr.push(TMP.matrix.clone());
    }
    return arr;
  }, [count, radius, topY, surface]);

  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  useEffect(() => {
    refs.current.forEach((mesh) => {
      if (!mesh) return;
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [matrices, parts]);

  useFrame((state) => {
    uniforms.current.uTime.value = state.clock.elapsedTime;
    uniforms.current.uWind.value = 0.45 + wind * 0.75 + gust * 0.16;
    uniforms.current.uWindDir.value.set(windVec[0], windVec[1]).normalize();
    uniforms.current.uCloudCover.value = cloudCover;
    uniforms.current.uAerial.value = aerial;
    uniforms.current.uHazeColor.value.set(hazeColor);
  });

  if (count <= 0) return null;

  return (
    <group>
      {parts.map((p, i) => (
        <instancedMesh
          key={i}
          ref={(m) => {
            refs.current[i] = m;
          }}
          args={[p.geo, p.mat, count]}
          castShadow={false}
          receiveShadow
        />
      ))}
    </group>
  );
}

