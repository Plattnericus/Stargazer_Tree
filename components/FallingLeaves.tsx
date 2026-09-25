"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { Season } from "@/lib/weather";
import type { SurfaceProfile } from "@/lib/surface";
import { useQualityProfile } from "@/lib/quality";

const TMP = new THREE.Object3D();

type LeafState = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  scale: number;
  landed: boolean;
  visible: boolean;
  landedAt: number;
  phase: number;
  dirty: boolean;
};

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLeafGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -0.11);
  s.bezierCurveTo(0.24, 0.02, 0.2, 0.45, 0, 0.63);
  s.bezierCurveTo(-0.2, 0.45, -0.24, 0.02, 0, -0.11);
  const g = new THREE.ShapeGeometry(s, 5);
  g.scale(0.46, 0.46, 0.46);
  g.computeVertexNormals();
  return g;
}

function leafColor(season: Season, rng: () => number) {
  const c = new THREE.Color();
  if (season === "autumn") c.setHSL(0.08 + rng() * 0.06, 0.72, 0.42 + rng() * 0.12);
  else if (season === "winter") c.setHSL(0.27 + rng() * 0.04, 0.14, 0.62 + rng() * 0.08);
  else c.setHSL(0.26 + rng() * 0.05, 0.48, 0.34 + rng() * 0.12);
  return c;
}

export function FallingLeaves({
  wind,
  gust = 0,
  windVec = [1, 0],
  season,
  surface,
  treeY,
  radius = 10.5,
  budget = 1,
  moving = false,
}: {
  wind: number;
  gust?: number;
  windVec?: [number, number];
  season: Season;
  surface?: SurfaceProfile;
  treeY: number;
  radius?: number;
  budget?: number;
  moving?: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const profile = useQualityProfile();
  const maxLeaves = Math.max(
    12,
    Math.round(profile.fallingLeaves * THREE.MathUtils.clamp(budget, 0.45, 1)),
  );
  const rngRef = useRef(mulberry(8042));
  const spawnAcc = useRef(0);
  const frameSkip = useRef(0);
  const dtAcc = useRef(0);
  const states = useMemo<{ current: LeafState[] }>(
    () => ({
      current: Array.from({ length: maxLeaves }, (_, i) => ({
        pos: new THREE.Vector3(0, -200, 0),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(),
        scale: 0,
        landed: false,
        visible: false,
        landedAt: -1000 - i,
        phase: i * 1.37,
        dirty: true,
      })),
    }),
    [maxLeaves],
  );

  const geometry = useMemo(makeLeafGeometry, []);
  // Per-leaf colors come from instanceColor. `vertexColors` must stay off: the
  // leaf geometry has no color attribute, and WebGL would read the missing
  // attribute as black.
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        roughness: 0.86,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    [],
  );

  const colors = useMemo(() => {
    const rng = mulberry(3301);
    return Array.from({ length: maxLeaves }, () => leafColor(season, rng));
  }, [season, maxLeaves]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    colors.forEach((c, i) => mesh.setColorAt(i, c));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [colors]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    TMP.position.set(0, -200, 0);
    TMP.rotation.set(0, 0, 0);
    TMP.scale.setScalar(0);
    TMP.updateMatrix();
    for (let i = 0; i < maxLeaves; i++) mesh.setMatrixAt(i, TMP.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, [maxLeaves]);

  const groundY = (p: THREE.Vector3) => {
    const limit = surface ? surface.edgeR * 0.96 : radius;
    const r = Math.hypot(p.x, p.z);
    if (r > limit) {
      const k = limit / r;
      p.x *= k;
      p.z *= k;
    }
    const rr = Math.hypot(p.x, p.z);
    return surface ? surface.heightAt(rr) + 0.035 : 5.2 - Math.pow(rr / radius, 2) * 1.6;
  };

  const spawn = (now: number) => {
    const rng = rngRef.current;
    const leaves = states.current;
    let pick = leaves.findIndex((l) => !l.visible);
    if (pick < 0) {
      let oldest = Infinity;
      for (let i = 0; i < leaves.length; i++) {
        if (leaves[i].landed && leaves[i].landedAt < oldest) {
          oldest = leaves[i].landedAt;
          pick = i;
        }
      }
      if (pick < 0 || now - oldest < 18) return;
    }

    const a = rng() * Math.PI * 2;
    const r = 2.4 + rng() * 7.6;
    const wx = windVec[0];
    const wz = windVec[1];
    const l = leaves[pick];
    l.pos.set(Math.cos(a) * r, treeY + 6.8 + rng() * 6.2, Math.sin(a) * r);
    l.vel.set(
      (rng() - 0.5) * 0.12 + wx * wind * 0.08,
      -0.18 - rng() * 0.16,
      (rng() - 0.5) * 0.12 + wz * wind * 0.08,
    );
    l.rot.set(rng() * Math.PI, rng() * Math.PI * 2, rng() * Math.PI);
    l.spin.set((rng() - 0.5) * 2.2, (rng() - 0.5) * 2.8, (rng() - 0.5) * 2.4);
    l.scale = 0.62 + rng() * 0.55;
    l.landed = false;
    l.visible = true;
    l.landedAt = now;
    l.phase = rng() * Math.PI * 2;
    l.dirty = true;
  };

  useFrame((state, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
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
    const d = Math.min(dt, moving ? 0.08 : 0.04);
    const windy = Math.max(0, wind + gust * 0.42 - 1.75);
    const wx = windVec[0];
    const wz = windVec[1];
    const sx = -wz;
    const sz = wx;
    const active = season === "autumn" || windy > 0.15;
    const spawnRate = active ? Math.min(3.2, (season === "autumn" ? 0.7 : 0) + windy * 1.4) : 0;

    spawnAcc.current += spawnRate * d;
    while (spawnAcc.current >= 1) {
      spawnAcc.current -= 1;
      spawn(t);
    }

    let changed = false;
    for (let i = 0; i < maxLeaves; i++) {
      const l = states.current[i];
      if (!l.visible) continue;
      if (l.landed) {
        if (!l.dirty) continue;
        TMP.position.copy(l.pos);
        TMP.rotation.set(-Math.PI / 2, l.rot.y, l.rot.z);
        TMP.scale.setScalar(l.scale);
      } else {
        const flutter = Math.sin(t * 2.1 + l.phase) * 0.12;
        l.vel.y = Math.max(-1.35, l.vel.y - 0.72 * d); // gravity with terminal velocity
        l.vel.multiplyScalar(1 - Math.min(0.08, d * 0.55)); // air drag
        const flow = wind + gust * 0.28;
        const targetX = wx * flow * 0.18 + sx * flutter * 0.42;
        const targetZ = wz * flow * 0.18 + sz * flutter * 0.42;
        l.vel.x += (targetX - l.vel.x) * d * 0.42;
        l.vel.z += (targetZ - l.vel.z) * d * 0.42;
        l.pos.addScaledVector(l.vel, d);
        l.pos.y += Math.sin(t * 3.0 + l.phase) * d * 0.045;
        l.rot.x += l.spin.x * d;
        l.rot.y += l.spin.y * d;
        l.rot.z += l.spin.z * d;

        const gy = groundY(l.pos);
        if (l.pos.y <= gy) {
          l.pos.y = gy;
          l.landed = true;
          l.landedAt = t;
          l.rot.x = -Math.PI / 2;
          l.spin.set(0, 0, 0);
          l.dirty = true;
        }
        TMP.position.copy(l.pos);
        TMP.rotation.copy(l.rot);
        TMP.scale.setScalar(l.scale);
      }
      TMP.updateMatrix();
      mesh.setMatrixAt(i, TMP.matrix);
      l.dirty = false;
      changed = true;
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      key={maxLeaves}
      ref={meshRef}
      args={[geometry, material, maxLeaves]}
    />
  );
}
