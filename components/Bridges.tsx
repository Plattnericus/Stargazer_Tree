"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MAX_HOUSES } from "@/lib/layout";
import { bonsaiAnchors } from "@/lib/bonsai";
import {
  buildLantern,
  setLanternGlow,
  LANTERN_LIGHT_THRESHOLD,
  LANTERN_SIZE,
  NIGHT_LIGHT,
} from "@/lib/lantern";
import { TIER_SIZE, resolveTier } from "@/lib/rarity";
import type { Stargazer } from "@/lib/stargazers";

const LANTERN = "/models/stylized_lantern.glb";
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DECK = 0.35; // platform deck top above the raw branch anchor (matches Houses)
const WALKWAY_RAISE = 0.24; // extra clearance so bridges visibly sit above branches
const TRUNK_R = 1.85; // prefer spans that do not cut through the central trunk
// Bridges are the DEFAULT: a flat plank bridge is a walkable ramp, so it can also
// climb. A ladder is ONLY used when the link is essentially "straight up" — the two
// decks are nearly stacked (tiny horizontal run) with a real height difference, so
// no bridge ramp could lie between them.
const MAX_BRIDGE_GAP = 13.5; // longest walkable plank span (edge-to-edge)
const MAX_BRIDGE_DH = 9; // a ramp bridge may climb this much…
const MAX_BRIDGE_SLOPE = 1.5; // …as long as it stays gentler than ~56° (rise/run)
const LADDER_MIN_DH = 1.0; // below this rise nothing needs a ladder
const LADDER_MAX_RUN = 2.6; // ladder only when decks are this close horizontally
const MAX_LADDER_HD = 11;

// Virtual node id for the island surface directly under platform 0 — the ONE
// guaranteed connector from the ground into the tree. Real platforms are
// 0..active-1, so a negative id can never collide with one.
const GROUND = -1;

const WOOD_NOISE = /* glsl */ `
  float whash(vec3 p){ return fract(sin(dot(p, vec3(17.17, 41.93, 9.71))) * 43758.5453); }
  float wnoise(vec3 p){
    vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(whash(i),whash(i+vec3(1,0,0)),f.x),
                   mix(whash(i+vec3(0,1,0)),whash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(whash(i+vec3(0,0,1)),whash(i+vec3(1,0,1)),f.x),
                   mix(whash(i+vec3(0,1,1)),whash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
`;

function applyWoodShader(mat: THREE.Material) {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return mat;
  mat.color.set("#8a572f");
  mat.roughness = 0.86;
  mat.metalness = 0;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec3 vWoodPos;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n vWoodPos = position;",
      );
    shader.fragmentShader =
      "varying vec3 vWoodPos;\n" +
      WOOD_NOISE +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float grain = wnoise(vec3(vWoodPos.x * 3.0, vWoodPos.y * 8.0, vWoodPos.z * 18.0));
        float lines = smoothstep(0.38, 0.92, sin(vWoodPos.x * 10.0 + grain * 3.0) * 0.5 + 0.5);
        vec3 warm = vec3(0.55, 0.33, 0.16);
        vec3 honey = vec3(0.78, 0.50, 0.24);
        vec3 deep = vec3(0.26, 0.14, 0.07);
        vec3 wood = mix(warm, honey, grain * 0.7);
        wood = mix(wood, deep, lines * 0.34);
        diffuseColor.rgb = mix(diffuseColor.rgb, wood, 0.9);`,
      );
  };
  mat.needsUpdate = true;
  return mat;
}

// A simple, sturdy wooden ladder built in code: two rails + rungs, built to the
// EXACT climb length with a FIXED rung pitch — a longer climb just gets MORE rungs
// at the same spacing, nothing is ever stretched. Centred at origin, long axis Y.
const LADDER_WOOD = applyWoodShader(
  new THREE.MeshStandardMaterial({
    color: "#8a572f",
    roughness: 0.86,
  }),
);
// Half-distance between the two rails. The gap must clear the walk-mode
// capsule (CAPSULE_R = 0.3 in WalkControls.tsx, 0.6 wide) with room to spare,
// or the character controller gets wedged between both rails.
const RAIL_GAP = 0.55;
const RUNG_PITCH = 0.34; // constant vertical spacing between rungs (never scaled)
function makeLadder(length: number): THREE.BufferGeometry {
  const L = Math.max(RUNG_PITCH, length);
  const geos: THREE.BufferGeometry[] = [];
  // two rails spanning the full length
  for (const x of [-RAIL_GAP, RAIL_GAP]) {
    const rail = new THREE.CylinderGeometry(0.045, 0.045, L, 6); // y: -L/2..L/2
    rail.translate(x, 0, 0);
    geos.push(rail);
  }
  // rungs at a constant pitch → add more as the ladder gets longer (no stretch)
  const n = Math.max(1, Math.round(L / RUNG_PITCH));
  const rungLen = RAIL_GAP * 2 + 0.04;
  for (let i = 0; i <= n; i++) {
    const rung = new THREE.CylinderGeometry(0.032, 0.032, rungLen, 6);
    rung.rotateZ(Math.PI / 2);
    rung.translate(0, -L / 2 + (i / n) * L, 0);
    geos.push(rung);
  }
  const merged = mergeGeometries(geos, false);
  merged.computeVertexNormals();
  return merged;
}

// A STRAIGHT, flat plank walkway (no sag) built to the exact span length, so it
// reads as a real, walkable bridge between two decks. Merged → one draw call.
function makeFlatBridge(length: number): THREE.BufferGeometry {
  const W = 0.64; // walkway width
  const L = Math.max(0.4, length);
  const geos: THREE.BufferGeometry[] = [];
  geos.push(new THREE.BoxGeometry(L, 0.06, W)); // deck slab
  const nPlanks = Math.max(4, Math.round(L / 0.3));
  for (let i = 0; i < nPlanks; i++) {
    const px = -L / 2 + ((i + 0.5) / nPlanks) * L;
    const pl = new THREE.BoxGeometry(0.17, 0.09, W * 0.96);
    pl.translate(px, 0.02, 0);
    geos.push(pl);
  }
  for (const s of [-1, 1]) {
    const rail = new THREE.BoxGeometry(L, 0.05, 0.05);
    rail.translate(0, 0.46, s * (W / 2 - 0.04));
    geos.push(rail);
    const nP = Math.max(2, Math.round(L / 0.75));
    for (let i = 0; i <= nP; i++) {
      const px = -L / 2 + (i / nP) * L;
      const post = new THREE.BoxGeometry(0.05, 0.5, 0.05);
      post.translate(px, 0.23, s * (W / 2 - 0.04));
      geos.push(post);
    }
  }
  const merged = mergeGeometries(geos, false);
  merged.computeVertexNormals();
  return merged;
}

// Closest distance (XZ) from the trunk (origin) to segment a→b.
function segDistToTrunkXZ(a: THREE.Vector3, b: THREE.Vector3): number {
  const ax = a.x;
  const az = a.z;
  const bx = b.x - ax;
  const bz = b.z - az;
  const len2 = bx * bx + bz * bz || 1;
  let t = -(ax * bx + az * bz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + bx * t, az + bz * t);
}

type SpanTransform = {
  visible: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  lanternVisible: boolean;
  lanternPosition: THREE.Vector3;
};

// Platform-to-platform walkways: a degree-capped spanning tree connects every
// deck, plus a ladder from the ground to the first platform. Spans with room
// get a flat plank bridge, nearly stacked decks a ladder, overlapping decks
// nothing. Each span carries a lantern.
export function Bridges({
  stars,
  night = 0,
  stargazers = null,
}: {
  stars: number;
  night?: number;
  stargazers?: Stargazer[] | null;
}) {
  const { scene: lanternScene } = useGLTF(LANTERN);
  const anchors = useMemo(() => bonsaiAnchors(MAX_HOUSES), []);

  // Deck radius per house — uses the SAME resolved tier as Houses so the bridge
  // ends land exactly on the deck rims.
  const deckRadius = useMemo(
    () => (i: number) => TIER_SIZE[resolveTier(i, stargazers)] * 1.5,
    [stargazers],
  );

  // The ground ladder stands just outside platform 0's deck rim (radially
  // outward) so the deck doesn't hide it; it is vertical, so it still tops
  // out at the deck height.
  const groundPos = useMemo(() => {
    const p = anchors[0]?.pos;
    if (!p) return new THREE.Vector3(0, 0, 0);
    const dir = new THREE.Vector3(p.x, 0, p.z);
    if (dir.lengthSq() < 0.001) dir.set(1, 0, 0);
    dir.normalize();
    return new THREE.Vector3(p.x, 0, p.z).addScaledVector(dir, deckRadius(0) * 0.95);
  }, [anchors, deckRadius]);
  // Faces the ladder's rungs toward the same outward radial direction the
  // player approaches from (they spawn further out along this exact line —
  // see WalkControls' setup()).
  const stairYaw = useMemo(() => {
    const p = anchors[0]?.pos;
    if (!p || (p.x === 0 && p.z === 0)) return 0;
    return Math.atan2(p.z, p.x);
  }, [anchors]);
  const posOf = useCallback(
    (i: number) => (i === GROUND ? groundPos : anchors[i].pos),
    [anchors, groundPos],
  );
  const radiusOf = useCallback(
    (i: number) => (i === GROUND ? 0 : deckRadius(i)),
    [deckRadius],
  );

  const active = Math.min(anchors.length, Math.max(0, Math.floor(stars)));

  const edges = useMemo<[number, number, boolean][]>(() => {
    const out: [number, number, boolean][] = [];
    if (active < 1) return out;

    const classify = (
      i: number,
      j: number,
    ): { cost: number; ladder: boolean; valid: boolean; hd: number } => {
      const a = posOf(i);
      const b = posOf(j);
      const hd = Math.hypot(b.x - a.x, b.z - a.z);
      const gap = Math.max(0, hd - radiusOf(i) - radiusOf(j));
      const dh = Math.abs(a.y - b.y);
      const run = Math.max(0.001, gap); // horizontal room a plank ramp has to lie in
      const slope = dh / run; // rise / run of a would-be ramp bridge
      const crossesTrunk = segDistToTrunkXZ(a, b) < TRUNK_R;
      // PREFER a walkable plank BRIDGE wherever one can span (it ramps up gently as
      // needed). Only when two decks are nearly stacked — a real rise with almost no
      // horizontal room — is it "straight up", and THAT gets a ladder.
      const canBridge =
        gap > 0.35 && gap <= MAX_BRIDGE_GAP && dh <= MAX_BRIDGE_DH && slope <= MAX_BRIDGE_SLOPE;
      const canLadder = dh > LADDER_MIN_DH && run <= LADDER_MAX_RUN && hd <= MAX_LADDER_HD;
      // The bridge wins ties — a ladder is the fallback only when no bridge fits.
      const useLadder = canLadder && !canBridge;
      const valid = (canBridge || canLadder) && !crossesTrunk;

      if (!valid) {
        return {
          cost: gap + dh * 1.8 + (crossesTrunk ? 7 : 0) + 12,
          ladder: useLadder || dh > LADDER_MIN_DH,
          valid: false,
          hd,
        };
      }
      return {
        // bias the spanning tree toward bridges; ladders carry a fixed surcharge so
        // they're only chosen where a bridge genuinely cannot reach.
        cost: gap + dh * 0.9 + (useLadder ? 4 : 0) + (crossesTrunk ? 6 : 0),
        ladder: useLadder,
        valid,
        hd,
      };
    };

    // 0) The one guaranteed connector: island surface → founder platform. It
    //    bypasses the degree cap and the `.valid` gate below.
    const ground = classify(GROUND, 0);
    out.push([GROUND, 0, ground.ladder]);
    if (active < 2) return out;

    // 1) Degree-capped spanning backbone so every deck is reachable WITHOUT any
    //    platform becoming a hub. A plain MST can attach many decks to one node
    //    (degree > cap); here we grow the tree but only ever attach to an in-tree
    //    node that still has spare capacity (degree < cap), cheapest first.
    const MAX_DEG = 3;
    const degree = new Array(active).fill(0);
    const inTree = new Array(active).fill(false);
    inTree[0] = true;
    for (let k = 1; k < active; k++) {
      let pick = -1;
      let pickParent = -1;
      let pickCost = Infinity;
      let pickLadder = false;
      for (let j = 0; j < active; j++) {
        if (inTree[j]) continue;
        for (let p = 0; p < active; p++) {
          if (!inTree[p] || degree[p] >= MAX_DEG) continue;
          const c = classify(p, j);
          if (c.cost < pickCost) {
            pickCost = c.cost;
            pick = j;
            pickParent = p;
            pickLadder = c.ladder;
          }
        }
      }
      if (pick < 0) break; // nothing reachable under the degree cap → stop
      inTree[pick] = true;
      degree[pick]++;
      degree[pickParent]++;
      out.push([pickParent, pick, pickLadder]);
    }

    // 2) Net: add a FEW cross-links so it reads as a web, not a single chain —
    //    every platform still stays capped at 2–3 connections total (reusing the
    //    `degree` maintained above). Top up to the cap with nearest neighbours.
    const has = new Set(out.map(([i, j]) => (i < j ? `${i}-${j}` : `${j}-${i}`)));
    for (let i = 0; i < active; i++) {
      if (degree[i] >= MAX_DEG) continue;
      const cands: { j: number; hd: number; ladder: boolean }[] = [];
      for (let j = 0; j < active; j++) {
        if (i === j) continue;
        const c = classify(i, j);
        if (c.valid) cands.push({ j, hd: c.hd, ladder: c.ladder });
      }
      cands.sort((a, b) => a.hd - b.hd);
      for (const cand of cands) {
        if (degree[i] >= MAX_DEG) break;
        if (degree[cand.j] >= MAX_DEG) continue;
        const key = i < cand.j ? `${i}-${cand.j}` : `${cand.j}-${i}`;
        if (has.has(key)) continue;
        has.add(key);
        out.push([i, cand.j, cand.ladder]);
        degree[i]++;
        degree[cand.j]++;
      }
    }
    return out;
  }, [active, posOf, radiusOf]);

  // Each span's geometry, built to its EXACT length once (positions are static):
  // a flat plank bridge for ramps, a fixed-pitch ladder for near-vertical climbs.
  // Both are rendered at scale 1 → nothing is ever stretched.
  const spanGeos = useMemo(
    () =>
      edges.map(([i, j, isLadder]) => {
        const a = posOf(i);
        const b = posOf(j);
        if (i === GROUND || j === GROUND) {
          const platform = i === GROUND ? j : i;
          const hiY = posOf(platform).y + DECK + WALKWAY_RAISE;
          return makeLadder(hiY - groundPos.y);
        }
        if (isLadder) {
          const lo = a.y <= b.y ? i : j;
          const hi = lo === i ? j : i;
          const loP = posOf(lo);
          const hiP = posOf(hi);
          const dx = hiP.x - loP.x;
          const dz = hiP.z - loP.z;
          const hd = Math.hypot(dx, dz) || 1;
          const ux = dx / hd;
          const uz = dz / hd;
          const sep = hd - radiusOf(lo) - radiusOf(hi);
          const ax = loP.x + ux * radiusOf(lo) * 0.99;
          const az = loP.z + uz * radiusOf(lo) * 0.99;
          const ay = loP.y + DECK + WALKWAY_RAISE;
          const by = hiP.y + DECK + WALKWAY_RAISE;
          const bx = sep > 0.2 ? hiP.x - ux * radiusOf(hi) * 0.99 : ax + ux * 0.3;
          const bz = sep > 0.2 ? hiP.z - uz * radiusOf(hi) * 0.99 : az + uz * 0.3;
          return makeLadder(Math.hypot(bx - ax, by - ay, bz - az));
        }
        const dh = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const inset = (radiusOf(i) + radiusOf(j)) * 0.97;
        const ay = a.y + DECK + WALKWAY_RAISE;
        const by = b.y + DECK + WALKWAY_RAISE;
        const span = Math.hypot(Math.max(0.4, dh - inset), by - ay);
        return makeFlatBridge(span);
      }),
    [edges, posOf, radiusOf],
  );
  useEffect(() => () => spanGeos.forEach((g) => g.dispose()), [spanGeos]);

  const transforms = useMemo<SpanTransform[]>(() => {
    const matrix = new THREE.Matrix4();
    const axX = new THREE.Vector3();
    const axZ = new THREE.Vector3();
    const a3 = new THREE.Vector3();
    const b3 = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const dirH = new THREE.Vector3();

    return edges.map(([i, j, isLadder]) => {
      const out: SpanTransform = {
        visible: true,
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        lanternVisible: true,
        lanternPosition: new THREE.Vector3(),
      };

      if (i === GROUND || j === GROUND) {
        const platform = i === GROUND ? j : i;
        const hiY = posOf(platform).y + DECK + WALKWAY_RAISE;
        out.position.set(groundPos.x, (groundPos.y + hiY) * 0.5, groundPos.z);
        // Built along its own Y already matching world-up (ground→platform-0
        // is near-vertical by construction — see groundPos), so no basis
        // rotation is needed; stairYaw just picks a facing for the rungs.
        out.quaternion.setFromAxisAngle(WORLD_UP, stairYaw);
        out.lanternPosition.set(groundPos.x, hiY + 0.1, groundPos.z);
        return out;
      }

      if (isLadder) {
        const lo = posOf(i).y <= posOf(j).y ? i : j;
        const hi = lo === i ? j : i;
        const loP = posOf(lo);
        const hiP = posOf(hi);
        dirH.set(hiP.x - loP.x, 0, hiP.z - loP.z);
        const hd = dirH.length() || 1;
        dirH.normalize();
        const sep = hd - radiusOf(lo) - radiusOf(hi);
        a3.set(
          loP.x + dirH.x * radiusOf(lo) * 0.99,
          loP.y + DECK + WALKWAY_RAISE,
          loP.z + dirH.z * radiusOf(lo) * 0.99,
        );
        if (sep > 0.2) {
          b3.set(
            hiP.x - dirH.x * radiusOf(hi) * 0.99,
            hiP.y + DECK + WALKWAY_RAISE,
            hiP.z - dirH.z * radiusOf(hi) * 0.99,
          );
        } else {
          b3.set(
            a3.x + dirH.x * 0.3,
            hiP.y + DECK + WALKWAY_RAISE,
            a3.z + dirH.z * 0.3,
          );
        }
        mid.copy(a3).add(b3).multiplyScalar(0.5);
        dir.copy(b3).sub(a3).normalize();
        axX.crossVectors(WORLD_UP, dir);
        if (axX.lengthSq() < 1e-4) axX.set(1, 0, 0);
        axX.normalize();
        axZ.crossVectors(axX, dir).normalize();
        matrix.makeBasis(axX, dir, axZ);
        out.position.copy(mid);
        out.quaternion.setFromRotationMatrix(matrix);
        out.lanternPosition.set(b3.x, b3.y + 0.05, b3.z);
        return out;
      }

      a3.copy(posOf(i));
      a3.y += DECK + WALKWAY_RAISE;
      b3.copy(posOf(j));
      b3.y += DECK + WALKWAY_RAISE;
      const hd = Math.hypot(b3.x - a3.x, b3.z - a3.z);
      const inset = radiusOf(i) + radiusOf(j);
      if (hd <= inset + 0.25) {
        out.visible = false;
        out.lanternVisible = false;
        return out;
      }
      dirH.set(b3.x - a3.x, 0, b3.z - a3.z).normalize();
      a3.addScaledVector(dirH, radiusOf(i) * 0.82);
      b3.addScaledVector(dirH, -radiusOf(j) * 0.82);
      mid.copy(a3).add(b3).multiplyScalar(0.5);
      dir.copy(b3).sub(a3).normalize();
      axZ.crossVectors(dir, WORLD_UP);
      if (axZ.lengthSq() < 1e-4) axZ.set(0, 0, 1);
      axZ.normalize();
      axX.crossVectors(axZ, dir).normalize();
      matrix.makeBasis(dir, axX, axZ);
      out.position.copy(mid);
      out.position.y += 0.02;
      out.quaternion.setFromRotationMatrix(matrix);
      out.lanternPosition.set(a3.x + dir.x * 0.7, a3.y + 0.05, a3.z + dir.z * 0.7);
      return out;
    });
  }, [edges, posOf, radiusOf, groundPos, stairYaw]);

  const refs = useRef<(THREE.Group | null)[]>([]);
  const lanternRefs = useRef<(THREE.Group | null)[]>([]);

  useLayoutEffect(() => {
    transforms.forEach((tr, k) => {
      const g = refs.current[k];
      const lg = lanternRefs.current[k];
      if (g) {
        g.visible = tr.visible;
        g.position.copy(tr.position);
        g.quaternion.copy(tr.quaternion);
        g.scale.set(1, 1, 1);
      }
      if (lg) {
        lg.visible = tr.lanternVisible;
        lg.position.copy(tr.lanternPosition);
      }
    });
  }, [transforms]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    transforms.forEach((tr, k) => {
      const lg = lanternRefs.current[k];
      if (lg && tr.lanternVisible) lg.rotation.z = Math.sin(t * 0.7 + k) * 0.04;
    });
  });

  // Lanterns are cloned ONCE per edge set — cloning per render (and per night
  // change) was a big source of main-thread churn.
  const lanterns = useMemo(
    () => edges.map(() => buildLantern(lanternScene, LANTERN_SIZE, 0, 1)),
    [edges, lanternScene],
  );
  useEffect(() => {
    for (const lantern of lanterns) setLanternGlow(lantern, 0.2 + night * 2.2);
  }, [lanterns, night]);

  const lightsOn = night > LANTERN_LIGHT_THRESHOLD;
  return (
    <group>
      {edges.map(([i, j], k) => {
        const lantern = lanterns[k];
        return (
          <group key={`${i}-${j}`}>
            <group
              ref={(g) => {
                refs.current[k] = g;
              }}
            >
              <mesh
                geometry={spanGeos[k] ?? undefined}
                material={LADDER_WOOD}
                castShadow
                receiveShadow
              />
            </group>
            <group
              ref={(g) => {
                lanternRefs.current[k] = g;
              }}
            >
              <primitive object={lantern} />
              {/* Stays mounted; only visible at night (see NIGHT_LIGHT). */}
              {k < 5 && (
                <pointLight
                  name={NIGHT_LIGHT}
                  visible={lightsOn}
                  color="#ffb765"
                  position={[0, 0.4, 0]}
                  intensity={lightsOn ? 4.6 * night : 0}
                  distance={3.6}
                  decay={2}
                />
              )}
            </group>
          </group>
        );
      })}
    </group>
  );
}

useGLTF.preload(LANTERN);
