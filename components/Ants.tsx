"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { MAX_HOUSES } from "@/lib/layout";
import { useQualityProfile } from "@/lib/quality";
import { bonsaiAnchors } from "@/lib/bonsai";
import { trunkBaseRadius, trunkHeight } from "@/lib/growth";
import { deckRadius } from "@/lib/rarity";
import type { Stargazer } from "@/lib/stargazers";

const ANT = "/models/ant.glb";
const DECK = 0.35;
const ANT_LEN = 1.16;

type Ant =
  | {
      kind: "deck";
      house: number;
      ox: number;
      oz: number;
      tx: number;
      tz: number;
      speed: number;
      yaw: number;
      bob: number;
      mode: "wander" | "enter" | "inside";
      wait: number;
    }
  | {
      kind: "trunk";
      p: number;
      speed: number;
      turns: number;
      phase: number;
      bob: number;
    };

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A living village: animated ant models wander the decks and climb the trunk. */
export function Ants({
  stars,
  stargazers = null,
  budget = 1,
  moving = false,
}: {
  stars: number;
  stargazers?: Stargazer[] | null;
  budget?: number;
  moving?: boolean;
}) {
  const { scene: antScene, animations } = useGLTF(ANT);
  // Villager counts come from the quality tier: skinned clones + their
  // AnimationMixers are the heaviest CPU loop in the scene.
  const profile = useQualityProfile();
  const agentBudget = THREE.MathUtils.clamp(budget, 0.45, 1);
  const perHouse = Math.max(1, Math.round(profile.antsPerHouse * agentBudget));
  const trunkAnts = Math.max(4, Math.round(profile.antsTrunk * agentBudget));
  const mixerStride = Math.max(
    profile.antMixerStride,
    Math.ceil(1 / agentBudget),
    moving ? 2 : 1,
  );
  const anchors = useMemo(() => bonsaiAnchors(MAX_HOUSES), []);
  const active = Math.min(anchors.length, Math.max(0, Math.floor(stars)));

  const ants = useMemo<Ant[]>(() => {
    const rand = rng(7);
    const out: Ant[] = [];
    for (let h = 0; h < MAX_HOUSES; h++) {
      for (let k = 0; k < perHouse; k++) {
        out.push({
          kind: "deck",
          house: h,
          ox: (rand() - 0.5) * 0.6,
          oz: (rand() - 0.5) * 0.6,
          tx: (rand() - 0.5) * 1.2,
          tz: (rand() - 0.5) * 1.2,
          speed: 0.35 + rand() * 0.4,
          yaw: rand() * Math.PI * 2,
          bob: rand() * Math.PI * 2,
          mode: rand() > 0.9 ? "enter" : "wander",
          wait: 0.6 + rand() * 3.4,
        });
      }
    }
    for (let i = 0; i < trunkAnts; i++) {
      out.push({
        kind: "trunk",
        p: i / trunkAnts,
        speed: 0.012 + rand() * 0.01,
        turns: 2.2 + rand() * 0.6,
        phase: rand() * Math.PI * 2,
        bob: rand() * Math.PI * 2,
      });
    }
    return out;
  }, [perHouse, trunkAnts]);

  const refs = useRef<(THREE.Group | null)[]>([]);
  const mixers = useRef<THREE.AnimationMixer[]>([]);
  const mixerFrame = useRef(0);
  const mixerAccum = useRef(0);

  const villagers = useMemo(() => {
    mixers.current = [];
    const box = new THREE.Box3().setFromObject(antScene);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const scale = ANT_LEN / Math.max(size.x, size.y, size.z, 0.001);
    const clip = animations[0];
    // Every ant looks the same, so they all share one tweaked material copy
    // instead of cloning it per ant.
    const tweaked = new Map<THREE.Material, THREE.Material>();
    const tweak = (mat: THREE.Material) => {
      let out = tweaked.get(mat);
      if (!out) {
        if (mat instanceof THREE.MeshStandardMaterial) {
          const cloned = mat.clone();
          cloned.roughness = 0.86;
          cloned.metalness = 0;
          cloned.envMapIntensity = 0.5;
          out = cloned;
        } else {
          out = mat;
        }
        tweaked.set(mat, out);
      }
      return out;
    };

    return ants.map((_, i) => {
      const root = new THREE.Group();
      const model = cloneSkeleton(antScene);
      model.position.set(-center.x, -box.min.y, -center.z);
      model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (!Array.isArray(obj.material)) obj.material = tweak(obj.material);
      });
      model.scale.setScalar(scale);
      root.add(model);

      if (clip) {
        const mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(clip);
        action.time = (i * 0.19) % clip.duration;
        action.timeScale = 0.75 + ((i * 17) % 9) * 0.06;
        action.play();
        mixers.current[i] = mixer;
      }

      return root;
    });
  }, [antScene, animations, ants]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const t = state.clock.elapsedTime;
    // Skinned animations update every Nth frame (accumulated dt keeps the
    // playback speed right), and only for ants that are actually visible:
    // houses that don't exist yet and ants inside a house skip the mixer.
    mixerFrame.current += 1;
    mixerAccum.current += d;
    if (mixerFrame.current % mixerStride === 0) {
      const step = mixerAccum.current;
      mixerAccum.current = 0;
      for (let i = 0; i < mixers.current.length; i++) {
        if (refs.current[i]?.visible) mixers.current[i]?.update(step);
      }
    }
    // trunk geometry the climbers ride (matches Tree.tsx): tall, thin, ends inside
    // the crown.
    const trunkH = trunkHeight(stars);
    const trunkBaseR = trunkBaseRadius(stars);
    const trunkWraps = THREE.MathUtils.clamp(trunkH / 11, 1, 3.5);

    for (let i = 0; i < ants.length; i++) {
      const root = refs.current[i];
      if (!root) continue;
      const ant = ants[i];

      if (ant.kind === "deck") {
        const h = ant.house;
        if (h >= active || !anchors[h]) {
          root.visible = false;
          continue;
        }

        const deckR = deckRadius(h, stargazers) * 0.78;

        if (ant.mode === "inside") {
          ant.wait -= d;
          root.visible = false;
          if (ant.wait <= 0) {
            const a = Math.random() * Math.PI * 2;
            const r = deckR * (0.18 + Math.random() * 0.18);
            ant.ox = Math.cos(a) * r;
            ant.oz = Math.sin(a) * r;
            const outA = a + (Math.random() - 0.5) * 1.4;
            const outR = deckR * (0.45 + Math.random() * 0.42);
            ant.tx = Math.cos(outA) * outR;
            ant.tz = Math.sin(outA) * outR;
            ant.mode = "wander";
          }
          continue;
        }

        root.visible = true;
        const dx = ant.tx - ant.ox;
        const dz = ant.tz - ant.oz;
        const dist = Math.hypot(dx, dz) || 1;

        if (dist < 0.06) {
          if (ant.mode === "enter") {
            ant.mode = "inside";
            ant.wait = 1.4 + Math.random() * 5.5;
            root.visible = false;
            continue;
          }

          if (Math.random() < 0.24) {
            ant.mode = "enter";
            ant.tx = (Math.random() - 0.5) * deckR * 0.16;
            ant.tz = (Math.random() - 0.5) * deckR * 0.16;
          } else {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * deckR * 0.95;
            ant.tx = Math.cos(a) * r;
            ant.tz = Math.sin(a) * r;
          }
        } else {
          const pace = ant.mode === "enter" ? ant.speed * 0.72 : ant.speed;
          const step = Math.min(1, (pace * d) / dist);
          ant.ox += dx * step;
          ant.oz += dz * step;
          ant.yaw = Math.atan2(dx, dz);
        }

        const base = anchors[h].pos;
        root.position.set(
          base.x + ant.ox,
          base.y + DECK + 0.05 + Math.sin(t * 8 + ant.bob) * 0.025,
          base.z + ant.oz,
        );
        root.rotation.set(0, ant.yaw, Math.sin(t * 4 + ant.bob) * 0.035);
        root.scale.setScalar(1.2);
      } else {
        root.visible = true;
        ant.p += ant.speed * d;
        if (ant.p > 1) ant.p -= 1;

        const y = THREE.MathUtils.lerp(0.5, trunkH - 1.5, ant.p);
        const trunkR = trunkBaseR * Math.pow(1 - THREE.MathUtils.clamp(y / trunkH, 0, 1), 0.72);
        const r = Math.max(0.2, trunkR) + 0.14; // ride on the bark surface
        const angle = ant.phase + ant.p * ant.turns * trunkWraps * Math.PI * 2;

        root.position.set(
          Math.cos(angle) * r,
          y + Math.sin(t * 7 + ant.bob) * 0.018,
          Math.sin(angle) * r,
        );
        root.rotation.set(
          0,
          -angle + Math.PI / 2,
          Math.PI / 2 - 0.5 + Math.sin(t + i) * 0.05,
        );
        root.scale.setScalar(1.05);
      }
    }
  });

  return (
    <group>
      {villagers.map((villager, i) => (
        <primitive
          key={i}
          ref={(g: THREE.Group | null) => {
            refs.current[i] = g;
          }}
          object={villager}
          visible={false}
        />
      ))}
    </group>
  );
}

useGLTF.preload(ANT);
