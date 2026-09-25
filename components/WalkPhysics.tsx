"use client";

// Everything that needs rapier lives in this module, so the physics engine
// (~2 MB of JS with an embedded WASM binary) is only downloaded when walk mode
// is opened. Load it through lib/walkPhysics.ts, never with a static import.

import type { ReactNode } from "react";
import { CuboidCollider, CylinderCollider, Physics, RigidBody } from "@react-three/rapier";
import { TREE_Y } from "@/lib/scene";

export { WalkControls } from "./WalkControls";

const ISLAND_RADIUS = 12.5;

/** Instantiates the rapier WASM ahead of <Physics>, which then mounts without a long suspend. */
export async function initPhysicsEngine(): Promise<void> {
  const rapier = await import("@dimforge/rapier3d-compat");
  await rapier.init();
}

export function PhysicsWorld({ paused, children }: { paused: boolean; children: ReactNode }) {
  return (
    <Physics paused={paused} gravity={[0, -26, 0]}>
      {children}
    </Physics>
  );
}

/** Fixed trimesh colliders cooked once, on mount, from the visible child meshes. */
export function MeshColliders({ children }: { children: ReactNode }) {
  return (
    <RigidBody type="fixed" colliders="trimesh">
      {children}
    </RigidBody>
  );
}

/**
 * The island mesh is far too dense to cook into a collider, so the walkable
 * top is a cylinder proxy. An invisible ring of box colliders around its edge
 * lets the character controller slide along the rim instead of walking off;
 * it spans from below the island to above the highest platform.
 */
export function IslandColliders() {
  const segments = 22;
  const wallHalfHeight = 26;
  const wallHalfThickness = 0.6;
  const segHalfLen = ((Math.PI * ISLAND_RADIUS) / segments) * 1.15;
  return (
    <>
      <RigidBody type="fixed" colliders={false}>
        <CylinderCollider args={[3, ISLAND_RADIUS]} position={[0, TREE_Y - 3, 0]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[0, TREE_Y + wallHalfHeight - 14, 0]}>
        {Array.from({ length: segments }, (_, i) => {
          const angle = (i / segments) * Math.PI * 2;
          return (
            <CuboidCollider
              key={i}
              args={[wallHalfThickness, wallHalfHeight, segHalfLen]}
              position={[Math.cos(angle) * ISLAND_RADIUS, 0, Math.sin(angle) * ISLAND_RADIUS]}
              rotation={[0, -angle, 0]}
            />
          );
        })}
      </RigidBody>
    </>
  );
}
