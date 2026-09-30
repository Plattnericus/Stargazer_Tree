"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import * as THREE from "three";
import { bonsaiNodes, spineAt } from "@/lib/bonsai";
import { MAX_HOUSES } from "@/lib/layout";
import { trunkBaseRadius, trunkHeight } from "@/lib/growth";
import { deckRadius, type Tier } from "@/lib/rarity";

const BIRD = "/models/bird_orange.glb";
const DOVE_SCALE = 0.42;

// A small, folded-wing dove rests on an existing rear platform railing. There is
// no marker or flying orbit: exploring the back of the tree reveals it.
export function Dove({
  stars = 0,
  interactive = true,
  onFind,
  moving = false,
  stargazers = null,
}: {
  stars?: number;
  interactive?: boolean;
  onFind?: () => void;
  moving?: boolean;
  stargazers?: { tier?: Tier }[] | null;
}) {
  const { scene, animations } = useGLTF(BIRD);
  const wrapper = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const discoverable = useRef(false);
  const hoveredRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const reducedMotion = useRef(false);
  const cameraPosition = useMemo(() => new THREE.Vector3(), []);

  const perch = useMemo(() => {
    const active = Math.min(MAX_HOUSES, Math.max(0, Math.floor(stars)));
    if (active >= 2) {
      const nodes = bonsaiNodes(active);
      const middle = trunkHeight(active) * 0.52;
      const preferred = new THREE.Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2);
      const score = (node: (typeof nodes)[number]) => {
        const alignment =
          Math.cos(node.angle) * preferred.x +
          Math.sin(node.angle) * preferred.z;
        return (
          (1 - alignment) * 3 +
          Math.abs(node.base.y - middle) / Math.max(1, middle)
        );
      };
      const branch = nodes.reduce((best, node) =>
        score(node) < score(best) ? node : best,
      );
      const radial = new THREE.Vector3(
        Math.cos(branch.angle),
        0,
        Math.sin(branch.angle),
      );
      // The outer rear railing is outside the foliage exclusion volume.
      // A bird buried in the crown would be clickable but impossible to see.
      const tip = branch.tip
        .clone()
        .addScaledVector(radial, deckRadius(branch.index, stargazers) * 0.97);
      tip.y += 0.55;
      return { center: branch.base, radial, tip, angle: branch.angle };
    }
    // Matches the y=2.4, angle=3.7 stub in Tree's merged wood geometry.
    const y = 2.4;
    const angle = 3.7;
    const center = spineAt(y);
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const direction = radial
      .clone()
      .add(new THREE.Vector3(0, 0.36, 0))
      .normalize();
    const radius = Math.max(
      0.12,
      trunkBaseRadius(stars) * Math.pow(1 - y / trunkHeight(stars), 0.72),
    );
    const tip = center.clone().addScaledVector(direction, radius * 0.85 + 0.42);
    tip.y += 0.13;
    return { center, radial, tip, angle };
  }, [stars, stargazers]);

  const { object, mixer, materials } = useMemo(() => {
    const object = cloneSkeleton(scene);
    const materials: THREE.MeshStandardMaterial[] = [];
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !node.material) return;
      const source = Array.isArray(node.material)
        ? node.material
        : [node.material];
      const ivory = source.map((material) => {
        const copy = (material as THREE.MeshStandardMaterial).clone();
        copy.map = null;
        copy.color.set("#dedcd1");
        copy.emissive?.set("#000000");
        copy.emissiveIntensity = 0;
        copy.roughness = 0.9;
        copy.metalness = 0;
        materials.push(copy);
        return copy;
      });
      node.material = Array.isArray(node.material) ? ivory : ivory[0];
      node.castShadow = true;
    });
    const mixer = new THREE.AnimationMixer(object);
    if (animations[0]) {
      const action = mixer.clipAction(animations[0]);
      action.timeScale = 0.35;
      action.play();
    }
    return { object, mixer, materials };
  }, [scene, animations]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotion.current = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      mixer.stopAllAction();
      materials.forEach((material) => material.dispose());
      if (hoveredRef.current) document.body.style.cursor = "auto";
    };
  }, [mixer, materials]);

  const leave = () => {
    hoveredRef.current = false;
    setHovered(false);
    document.body.style.cursor = "auto";
  };
  useEffect(() => {
    if (!interactive) leave();
  }, [interactive]);
  const mixerFrame = useRef(0);
  const mixerAccum = useRef(0);
  useFrame(({ camera }, dt) => {
    const group = wrapper.current;
    if (!group?.parent) return;
    camera.getWorldPosition(cameraPosition);
    group.parent.worldToLocal(cameraPosition);
    const dx = cameraPosition.x - perch.center.x;
    const dz = cameraPosition.z - perch.center.z;
    const facing =
      (dx * perch.radial.x + dz * perch.radial.z) /
      Math.max(0.001, Math.hypot(dx, dz));
    // Also gate the hit target: Three's event raycast can otherwise hit an
    // invisible sphere through the trunk and give away the secret on hover.
    discoverable.current = facing > 0.05;
    group.visible = facing > -0.1;
    if (!discoverable.current && hoveredRef.current) leave();
    if (inner.current) {
      const target = hovered ? DOVE_SCALE * 1.09 : DOVE_SCALE;
      const scale = THREE.MathUtils.damp(inner.current.scale.x, target, 9, dt);
      inner.current.scale.setScalar(scale);
    }
    if (!group.visible || reducedMotion.current) return;
    mixerFrame.current += 1;
    mixerAccum.current += dt;
    if (mixerFrame.current % (moving ? 3 : 2) === 0) {
      mixer.update(mixerAccum.current);
      mixerAccum.current = 0;
    }
  });

  const enter = (event: ThreeEvent<PointerEvent>) => {
    if (!discoverable.current) return;
    event.stopPropagation();
    hoveredRef.current = true;
    setHovered(true);
    document.body.style.cursor = "pointer";
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    if (!discoverable.current) return;
    event.stopPropagation();
    leave();
    onFind?.();
  };

  return (
    <group
      ref={wrapper}
      name="memorial-dove"
      position={perch.tip}
      rotation={[0, perch.angle, 0]}
      visible={false}
    >
      <group ref={inner} scale={DOVE_SCALE}>
        <mesh
          position={[0, 0.65, 0]}
          {...(interactive && onFind
            ? { onPointerOver: enter, onPointerOut: leave, onClick: click }
            : {})}
        >
          <sphereGeometry args={[0.9, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        <primitive object={object} />
      </group>
    </group>
  );
}

useGLTF.preload(BIRD);
