"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import { bonsaiAnchors } from "@/lib/bonsai";
import { makeWing, flapAngle } from "@/lib/wing";

const BIRD = "/models/bird_orange.glb";

// Tunables (tree-local units). If a bird flies tail-first, flip MODEL_YAW.
const BIRD_SCALE = 0.5;
const MODEL_YAW = 0;
const CRUISE_SPEED = 7;
const TURN_RATE = 2.6;
const WING_COLOR = "#d98a3a";

type State = "cruise" | "toPerch" | "perched" | "launch";

type Bird = {
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  wingL: THREE.Group;
  wingR: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  state: State;
  timer: number;
  perchIdx: number;
  rot: THREE.Euler;
  phase: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// A flight target around the tree. ~40% of the time it's a far, high excursion
// so birds genuinely fly out of frame and circle back like real birds.
function roamTarget(out: THREE.Vector3) {
  const a = Math.random() * Math.PI * 2;
  if (Math.random() < 0.4) {
    const r = rand(22, 38);
    out.set(Math.cos(a) * r, rand(10, 22), Math.sin(a) * r);
  } else {
    const r = rand(7, 16);
    out.set(Math.cos(a) * r, rand(4.5, 11), Math.sin(a) * r);
  }
  return out;
}

export function Birds({
  count = 4,
  stars = 0,
  moving = false,
}: {
  count?: number;
  stars?: number;
  moving?: boolean;
}) {
  const { scene: birdScene, animations } = useGLTF(BIRD);

  // Real branch tips the birds can land on (procedural tree, tree-local space).
  const perches = useMemo(() => bonsaiAnchors(14).map((a) => a.pos), []);
  const occupied = useRef<Set<number>>(new Set());
  // Only branches that have actually grown (one per star) are real perches —
  // otherwise birds "land" on an invisible branch and appear to hover mid-air.
  const activePerches = Math.min(perches.length, Math.max(0, Math.floor(stars)));

  const birds = useMemo<Bird[]>(() => {
    occupied.current = new Set();
    return Array.from({ length: count }, () => {
      const obj = cloneSkeleton(birdScene);
      obj.scale.setScalar(BIRD_SCALE);
      const mixer = new THREE.AnimationMixer(obj);
      if (animations[0]) {
        const action = mixer.clipAction(animations[0]);
        action.play();
        action.time = Math.random() * 5;
      }
      const wingR = makeWing(1, WING_COLOR, "#a85f24", 0.5);
      const wingL = makeWing(-1, WING_COLOR, "#a85f24", 0.5);
      wingR.position.set(0.07, 0.4, 0.05);
      wingL.position.set(-0.07, 0.4, 0.05);
      return {
        obj,
        mixer,
        wingL,
        wingR,
        pos: roamTarget(new THREE.Vector3()),
        vel: new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).normalize().multiplyScalar(CRUISE_SPEED),
        target: roamTarget(new THREE.Vector3()),
        state: "cruise" as State,
        timer: rand(5, 12),
        perchIdx: -1,
        rot: new THREE.Euler(0, 0, 0, "YXZ"),
        phase: Math.random() * Math.PI * 2,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [birdScene, animations, count]);

  useEffect(() => {
    return () => birds.forEach((b) => b.mixer.stopAllAction());
  }, [birds]);

  const wrappers = useRef<(THREE.Group | null)[]>([]);
  const tmpDir = useMemo(() => new THREE.Vector3(), []);
  const tmpSteer = useMemo(() => new THREE.Vector3(), []);
  const mixerFrame = useRef(0);
  const mixerAccum = useRef(0);

  const pickPerch = (b: Bird) => {
    const free: number[] = [];
    for (let i = 0; i < activePerches; i++) if (!occupied.current.has(i)) free.push(i);
    if (!free.length) return false;
    const idx = free[Math.floor(Math.random() * free.length)];
    occupied.current.add(idx);
    b.perchIdx = idx;
    b.target.copy(perches[idx]);
    b.target.y += 0.16;
    b.state = "toPerch";
    return true;
  };

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = state.clock.elapsedTime;
    const mixerStride = moving ? 2 : 1;
    mixerFrame.current += 1;
    mixerAccum.current += dt;
    const updateMixers = mixerFrame.current % mixerStride === 0;
    const mixerDt = mixerAccum.current;
    if (updateMixers) mixerAccum.current = 0;
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      const g = wrappers.current[i];
      if (!g) continue;
      const flying = b.state !== "perched";

      if (b.state === "perched") {
        b.timer -= dt;
        if (b.timer <= 0) {
          b.state = "launch";
          if (b.perchIdx >= 0) occupied.current.delete(b.perchIdx);
          b.perchIdx = -1;
          roamTarget(b.target);
          b.target.y = Math.max(b.target.y, b.pos.y + 3);
          b.timer = rand(6, 12);
        }
      } else {
        tmpDir.copy(b.target).sub(b.pos);
        const dist = tmpDir.length();
        tmpDir.normalize();
        const speed =
          b.state === "toPerch"
            ? THREE.MathUtils.clamp(dist * 1.8, 0.5, CRUISE_SPEED)
            : b.state === "launch"
              ? CRUISE_SPEED * 1.3
              : CRUISE_SPEED * rand(0.92, 1.12);
        tmpSteer.copy(tmpDir).multiplyScalar(speed).sub(b.vel);
        b.vel.addScaledVector(tmpSteer, Math.min(1, TURN_RATE * dt));
        b.pos.addScaledVector(b.vel, dt);

        if (b.state === "cruise") {
          if (dist < 2.5) roamTarget(b.target);
          b.timer -= dt;
          if (b.timer <= 0 && !pickPerch(b)) b.timer = rand(4, 8);
        } else if (b.state === "launch") {
          if (dist < 3) {
            b.state = "cruise";
            b.timer = rand(6, 13);
          }
        } else if (b.state === "toPerch" && dist < 0.25) {
          b.pos.copy(b.target);
          b.vel.setScalar(0);
          b.state = "perched";
          b.timer = rand(5, 11);
        }
      }

      // face travel, pitch with climb, bank into turns
      const sp = b.vel.length();
      if (sp > 0.05) {
        const yaw = Math.atan2(b.vel.x, b.vel.z) + MODEL_YAW;
        const pitch = -Math.asin(THREE.MathUtils.clamp(b.vel.y / sp, -1, 1)) * 0.6;
        let dyaw = yaw - b.rot.y;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        b.rot.y += dyaw * Math.min(1, dt * 6);
        b.rot.x += (pitch - b.rot.x) * Math.min(1, dt * 5);
        b.rot.z += (-dyaw * 2.2 - b.rot.z) * Math.min(1, dt * 5);
      }

      // real flapping wings + a body bob synced to the beat
      const hz = 12;
      const flap = flapAngle(t, b.phase, flying, hz);
      b.wingR.rotation.z = flap;
      b.wingL.rotation.z = -flap;
      const bob = flying ? Math.sin(t * hz + b.phase) * 0.05 : 0;
      g.position.set(b.pos.x, b.pos.y + bob, b.pos.z);
      g.rotation.copy(b.rot);

      // model's own clip keeps head/tail/feet alive
      if (updateMixers) b.mixer.update(mixerDt * (flying ? 1 : 0.85));
    }
  });

  return (
    <group>
      {birds.map((b, i) => (
        <group
          key={i}
          ref={(g) => {
            wrappers.current[i] = g;
          }}
        >
          <primitive object={b.obj} />
          <primitive object={b.wingL} />
          <primitive object={b.wingR} />
        </group>
      ))}
    </group>
  );
}

useGLTF.preload(BIRD);
