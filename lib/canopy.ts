// Procedural canopy for the star tree: a recursive twig system plus the leaf
// sprigs hung on it, kept clear of the house decks and bridge corridors.
//
// Pure and deterministic (seeded), and free of React and DOM access, so it
// runs in lib/tree.worker.ts off the main thread; lib/treeWorkerClient.ts falls
// back to calling it directly where workers aren't available.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bonsaiNodes, makeTaperedTubeGeometry, spineAt } from "./bonsai";
import { treeHeight, trunkHeight } from "./growth";
import { MAX_HOUSES } from "./layout";

export type CanopyInput = {
  /** Houses (branches) present. */
  active: number;
  stars: number;
  /** Leaf sprigs per burst, from the quality tier. */
  sprigDensity: number;
  /** Twig/shell budget scale, from the quality tier. */
  budgetScale: number;
  /** Deck radius of each active house, which the foliage keeps clear of. */
  deckRadii: number[];
};

export type CanopyData = {
  /** Merged twig tubes, or null when there are none. */
  branch: {
    position: Float32Array;
    normal: Float32Array;
    uv: Float32Array;
    index: Uint16Array | Uint32Array;
  } | null;
  /** SPRIG_STRIDE numbers per sprig: position xyz, rotation xyz, scale, shade, hue, phase. */
  sprigs: Float64Array;
};

export const SPRIG_STRIDE = 10;

type Sprig = {
  pos: THREE.Vector3;
  rot: [number, number, number];
  scl: number;
  shade: number; // 0 deep inside the crown .. 1 outer/top (baked AO)
  hue: number; // per-sprig warm/cool + translucency variation
  phase: number; // wind decorrelation
};

const NODES = bonsaiNodes(MAX_HOUSES);

export function canopyKey(input: CanopyInput): string {
  return [input.active, input.stars, input.sprigDensity, input.budgetScale, input.deckRadii.join(",")].join("|");
}

export function buildCanopy({ active, stars, sprigDensity, budgetScale, deckRadii }: CanopyInput): CanopyData {
  const decks = Array.from({ length: active }, (_, i) => {
    const r = deckRadii[i];
    return { c: NODES[i].tip, r, top: 0.35 + (r / 1.5) * 1.9 };
  });
  // Bridge corridors between nearby decks. They never change, so they're
  // collected once here instead of re-deriving all deck pairs on each of the
  // ~100k blocked() calls. yMin/yMax bound the corridor's centre line and
  // only let blocked() skip corridors that could never match.
  const corridors: {
    ax: number;
    ay: number;
    az: number;
    abx: number;
    aby: number;
    abz: number;
    len2: number;
    yMin: number;
    yMax: number;
  }[] = [];
  for (let i = 0; i < decks.length; i++) {
    for (let j = i + 1; j < decks.length; j++) {
      const a = decks[i].c;
      const b = decks[j].c;
      const gap = Math.hypot(b.x - a.x, b.z - a.z) - decks[i].r - decks[j].r;
      if (gap < 0.4 || gap > 6) continue;
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      corridors.push({
        ax: a.x,
        ay: a.y,
        az: a.z,
        abx,
        aby: b.y - a.y,
        abz,
        len2: abx * abx + abz * abz,
        yMin: Math.min(a.y, b.y) + 0.5 - 1e-6,
        yMax: Math.max(a.y, b.y) + 0.5 + 1e-6,
      });
    }
  }
  // Keep foliage clear of decks, houses, and bridge corridors.
  const blocked = (p: THREE.Vector3, scl: number) => {
    const pad = 0.35 + scl * 0.22;
    for (const d of decks) {
      const dx = p.x - d.c.x;
      const dz = p.z - d.c.z;
      if (
        dx * dx + dz * dz < (d.r + pad) * (d.r + pad) &&
        p.y > d.c.y - 0.5 - scl * 0.3 &&
        p.y < d.c.y + d.top + scl * 0.45
      )
        return true;
    }
    const reachY = 1.2 + scl * 0.3;
    const rr = 1.0 + scl * 0.45;
    for (const c of corridors) {
      if (p.y <= c.yMin - reachY || p.y >= c.yMax + reachY) continue;
      const t = THREE.MathUtils.clamp(((p.x - c.ax) * c.abx + (p.z - c.az) * c.abz) / c.len2, 0, 1);
      const cx = c.ax + c.abx * t;
      const cz = c.az + c.abz * t;
      const cy = c.ay + c.aby * t + 0.5;
      if ((p.x - cx) ** 2 + (p.z - cz) ** 2 < rr * rr && Math.abs(p.y - cy) < reachY) return true;
    }
    return false;
  };

  // Crown bounds wrap the platforms and cover the trunk tip.
  let lowPlatY = Infinity;
  let maxReach = 3.2;
  for (let i = 0; i < active; i++) {
    const t = NODES[i].tip;
    maxReach = Math.max(maxReach, Math.hypot(t.x, t.z) + deckRadii[i]);
    lowPlatY = Math.min(lowPlatY, NODES[i].base.y);
  }
  if (!isFinite(lowPlatY)) lowPlatY = 2;
  const trunkTopY = trunkHeight(stars);
  const apexY = treeHeight(stars);
  const cBot = Math.max(1.0, lowPlatY - 0.8);
  const cRX = maxReach + 1.0;
  const span = Math.max(2, apexY - cBot);
  const GA = Math.PI * (3 - Math.sqrt(5));
  const BS = budgetScale;
  // A giant tree carries proportionally bigger tufts instead of exploding
  // the instance count.
  const sprigBoost = 1 + 0.15 * THREE.MathUtils.clamp(span / 14 - 1, 0, 1);

  // Recursive branch system for the canopy.
  const branchGeos: THREE.BufferGeometry[] = [];
  const sprigs: Sprig[] = [];
  let seed = 7;
  const rnd = () => {
    seed += 1;
    const x = Math.sin(seed * 91.7 + 13.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  // Rotate child branches away from the parent direction.
  const childDir = (dir: THREE.Vector3, spread: number) => {
    const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
    const p1 = new THREE.Vector3().crossVectors(dir, ref).normalize();
    const p2 = new THREE.Vector3().crossVectors(dir, p1).normalize();
    const ang = rnd() * Math.PI * 2;
    const axis = p1
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(p2, Math.sin(ang))
      .normalize();
    return dir.clone().applyAxisAngle(axis, spread).addScaledVector(UP, 0.28).normalize();
  };
  const addLeaf = (p: THREE.Vector3, anchor?: THREE.Vector3, twigRadius = 0.018) => {
    // Crown-depth shade input: radial distance from the spine relative to
    // the local dome radius (reused below as baked per-instance AO).
    const vh = THREE.MathUtils.clamp((p.y - cBot) / span, 0, 1);
    const dR = Math.max(0.6, cRX * (0.5 + 0.5 * Math.min(1, vh * 1.2)));
    const spn = spineAt(p.y);
    const radial = Math.hypot(p.x - spn.x, p.z - spn.z) / dR;
    let scl = (0.7 + rnd() * 0.75) * sprigBoost;
    // Bigger tufts on the silhouette break the smooth dome into real lobes.
    if (radial > 0.8) scl *= 1.25;
    if (blocked(p, scl)) return;
    if (anchor) {
      const d = p.distanceTo(anchor);
      if (d > 0.05) {
        const mid = anchor.clone().lerp(p, 0.65);
        mid.y += d * 0.08;
        branchGeos.push(
          makeTaperedTubeGeometry(
            [anchor, mid, p],
            twigRadius,
            twigRadius * 0.42,
            2,
            4,
            seed * 0.37,
          ),
        );
      }
    }
    const shade = THREE.MathUtils.clamp(radial * 0.85 + vh * 0.25, 0, 1);
    sprigs.push({
      pos: p,
      rot: [rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI],
      scl,
      shade,
      hue: rnd(),
      phase: rnd(),
    });
  };
  const addLeafBurst = (
    anchor: THREE.Vector3,
    dir: THREE.Vector3,
    baseCount: number,
    spread: number,
    twigRadius: number,
  ) => {
    // Canopy density scales with the graphics tier.
    const count = Math.max(1, Math.round(baseCount * sprigDensity));
    for (let b = 0; b < count; b++) {
      const side = new THREE.Vector3(
        Math.cos(seed * 0.91 + b * 2.399),
        (rnd() - 0.45) * 0.7,
        Math.sin(seed * 0.91 + b * 2.399),
      )
        .addScaledVector(dir, 0.65 + rnd() * 0.55)
        .normalize();
      const p = anchor
        .clone()
        .addScaledVector(side, spread * (0.45 + rnd() * 0.7));
      addLeaf(p, anchor, twigRadius);
    }
  };

  // Size-STABLE density: budgets grow with the crown span (no hard ceiling
  // that would starve a tall tree of leaves) — the tier scales via BS.
  let budget = Math.round(THREE.MathUtils.clamp(span, 4, 26) * 420 * BS);
  const grow = (
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    len: number,
    rad: number,
    depth: number,
  ) => {
    if (budget-- <= 0) return;
    const end = pos.clone().addScaledVector(dir, len);
    end.y -= Math.max(0, 1 - rad * 6) * len * 0.14;
    if (blocked(end, rad * 3 + 0.25)) return;
    const mid = pos.clone().addScaledVector(dir, len * 0.5);
    branchGeos.push(makeTaperedTubeGeometry([pos, mid, end], rad, rad * 0.66, 3, 4, seed * 0.7));
    if (depth <= 0 || len < 0.34) {
      addLeafBurst(end, dir, 14, 0.48, rad * 0.16);
      return;
    }
    // Add denser foliage on thinner outer twigs.
    if (depth <= 3) addLeafBurst(end, dir, 2, 0.18, rad * 0.22);
    if (depth <= 2) addLeafBurst(end, dir, 3, 0.26, rad * 0.2);
    if (depth <= 1) addLeafBurst(end, dir, 8, 0.4, rad * 0.18);
    const n = depth >= 3 ? (rnd() < 0.5 ? 3 : 2) : 2;
    for (let c = 0; c < n; c++) {
      grow(end, childDir(dir, 0.3 + rnd() * 0.4), len * (0.62 + rnd() * 0.16), rad * 0.68, depth - 1);
    }
  };

  // Main crown shell — scales with span so big trees stay just as lush.
  const NC = Math.max(90, Math.round((span * 7.5 + 50) * BS));
  for (let i = 0; i < NC; i++) {
    const v = i / Math.max(1, NC - 1);
    const ty = cBot + v * (apexY - cBot) + (rnd() - 0.5) * 0.9;
    const cap = Math.pow(Math.max(0, (v - 0.85) / 0.15), 2);
    const domeR = cRX * (0.5 + 0.5 * Math.min(1, v * 1.2)) * (1 - 0.5 * cap);
    const a = i * GA + rnd() * 0.5;
    const rr = 0.5 + 0.5 * Math.sqrt(rnd());
    const target = new THREE.Vector3(Math.cos(a) * domeR * rr, ty, Math.sin(a) * domeR * rr);
    if (blocked(target, 0.7)) continue;
    const oy = THREE.MathUtils.clamp(ty - 1.0 - rnd() * 1.0, cBot - 0.5, trunkTopY);
    const sp = spineAt(oy);
    const dir = target.clone().sub(sp);
    if (dir.lengthSq() < 0.01) continue;
    dir.normalize();
    grow(sp, dir, 1.8 + rnd() * 0.65, 0.09, 5);
  }
  // Leaf collars around active platforms.
  for (let i = 0; i < active; i++) {
    const base = NODES[i].base;
    const tip = NODES[i].tip;
    const dr = deckRadii[i];
    const RING = 8;
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2 + i * 1.3;
      const o = tip
        .clone()
        .add(new THREE.Vector3(Math.cos(a) * dr * 1.04, -0.25 + rnd() * 0.3, Math.sin(a) * dr * 1.04));
      const out = new THREE.Vector3(Math.cos(a) * 0.85, 0.45 + rnd() * 0.6, Math.sin(a) * 0.85).normalize();
      grow(o, out, 1.15 + rnd() * 0.65, 0.06, 3);
    }
    // Add a small leafy backdrop behind each deck.
    for (let k = 0; k < 3; k++) {
      const a = i * 1.3 + k * 1.7;
      const o = tip
        .clone()
        .add(new THREE.Vector3(Math.cos(a) * dr * 1.08, 0.1, Math.sin(a) * dr * 1.08));
      grow(o, new THREE.Vector3(Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35).normalize(), 1.65 + rnd() * 0.65, 0.055, 3);
    }
  }
  // Dense tip canopy around the upper trunk.
  for (let k = 0; k < 14; k++) {
    const a = k * GA + 0.3;
    const o = spineAt(trunkTopY - rnd() * 1.6);
    const out = new THREE.Vector3(Math.cos(a), 0.25 + rnd() * 0.7, Math.sin(a)).normalize();
    grow(o, out, 0.9 + rnd() * 0.75, 0.05, 3);
  }
  const tipBase = spineAt(trunkTopY);
  for (let k = 0; k < 16; k++) {
    const p = tipBase
      .clone()
      .add(new THREE.Vector3((rnd() - 0.5) * 1.3, rnd() * 1.5 - 0.2, (rnd() - 0.5) * 1.3));
    addLeaf(p, tipBase, 0.024);
  }

  // Inner rosette that covers the trunk from top-down views.
  for (let layer = 0; layer < 5; layer++) {
    const lt = layer / 4;
    const center = spineAt(trunkTopY - 0.7 + lt * 2.2);
    const ring = 14 + layer * 3;
    for (let k = 0; k < ring; k++) {
      const a = k * GA + layer * 0.58;
      const radius = THREE.MathUtils.lerp(0.45, 2.55, lt) * (0.75 + rnd() * 0.5);
      const p = center.clone().add(
        new THREE.Vector3(
          Math.cos(a) * radius,
          (rnd() - 0.25) * 0.45,
          Math.sin(a) * radius,
        ),
      );
      addLeaf(p, center, 0.026);
      if (k % 2 === 0) {
        const out = p.clone().sub(center);
        if (out.lengthSq() > 0.01) addLeafBurst(p, out.normalize(), 3, 0.3, 0.016);
      }
    }
  }

  // Central canopy plug for the top-down camera.
  const plugLayers = 6;
  for (let layer = 0; layer < plugLayers; layer++) {
    const lt = layer / (plugLayers - 1);
    const y = THREE.MathUtils.lerp(cBot + span * 0.48, apexY + 0.55, lt);
    const center = spineAt(y);
    const ring = 12 + Math.round(lt * 14);
    const maxR = THREE.MathUtils.lerp(0.8, 3.0, Math.sin(lt * Math.PI));
    for (let k = 0; k < ring; k++) {
      const a = k * GA + layer * 0.41 + rnd() * 0.12;
      const inner = k % 5 === 0 ? 0.05 + rnd() * 0.18 : 0.22 + rnd() * maxR;
      const p = center.clone().add(
        new THREE.Vector3(
          Math.cos(a) * inner,
          (rnd() - 0.35) * 0.5,
          Math.sin(a) * inner,
        ),
      );
      addLeaf(p, center, 0.022);
      if (k % 3 === 0) {
        const out = p.clone().sub(center);
        if (out.lengthSq() > 0.01) addLeafBurst(p, out.normalize(), 2, 0.24, 0.014);
      }
    }
  }

  // Layered radial branches around the upper trunk.
  const sleeveLayers = 5;
  for (let layer = 0; layer < sleeveLayers; layer++) {
    const ly = THREE.MathUtils.lerp(trunkTopY - 2.3, trunkTopY + 1.7, layer / (sleeveLayers - 1));
    const center = spineAt(ly);
    const ring = layer < 2 ? 12 : 16;
    const layerT = layer / (sleeveLayers - 1);
    const baseReach = THREE.MathUtils.lerp(2.2, 4.3, Math.sin(layerT * Math.PI));
    for (let k = 0; k < ring; k++) {
      const a = k * GA + layer * 0.73 + rnd() * 0.18;
      const reach = baseReach * (0.72 + rnd() * 0.45);
      const out = new THREE.Vector3(
        Math.cos(a) * reach,
        -0.08 + rnd() * 0.55 + layerT * 0.25,
        Math.sin(a) * reach,
      );
      const target = center.clone().add(out);
      if (blocked(target, 0.9)) continue;
      const dir = target.clone().sub(center);
      if (dir.lengthSq() < 0.01) continue;
      grow(center, dir.normalize(), 1.05 + rnd() * 0.45, 0.05, 3);
    }
  }

  // Apex fill uses supported twig growth, not loose leaves.
  const topStart = cBot + span * 0.55;
  const NF = Math.max(80, Math.round(span * 12 * BS));
  for (let i = 0; i < NF; i++) {
    const ty = topStart + (i / Math.max(1, NF - 1)) * (apexY + 0.8 - topStart) + (rnd() - 0.5) * 0.8;
    const vv = THREE.MathUtils.clamp((ty - cBot) / span, 0, 1);
    const cap = Math.pow(Math.max(0, (vv - 0.85) / 0.15), 2);
    const domeR = cRX * (0.5 + 0.5 * Math.min(1, vv * 1.2)) * (1 - 0.5 * cap);
    const a = i * GA + rnd() * 0.6;
    const rr = 0.35 + 0.65 * Math.sqrt(rnd());
    const target = new THREE.Vector3(Math.cos(a) * domeR * rr, ty, Math.sin(a) * domeR * rr);
    if (blocked(target, 0.7)) continue;
    const oy = THREE.MathUtils.clamp(ty - 0.8 - rnd() * 1.5, cBot, trunkTopY);
    const sp = spineAt(oy);
    const dir = target.clone().sub(sp);
    if (dir.lengthSq() < 0.01) continue;
    grow(sp, dir.normalize(), 1.35 + rnd() * 0.55, 0.058, 4);
  }

  // Inner-volume fill: plain sprigs INSIDE the hull (no twig geometry) so
  // the crown reads as a solid mass when the camera dives in or orbits low —
  // without it the shell is visibly hollow.
  const NI = Math.round(NC * 0.35);
  for (let i = 0; i < NI; i++) {
    const vv = 0.15 + 0.75 * rnd();
    const ty = cBot + vv * span;
    const cap = Math.pow(Math.max(0, (vv - 0.85) / 0.15), 2);
    const domeR = cRX * (0.5 + 0.5 * Math.min(1, vv * 1.2)) * (1 - 0.5 * cap);
    const a = i * GA + rnd() * 0.7;
    const rr = 0.25 + 0.4 * rnd();
    const c = spineAt(ty);
    addLeaf(
      new THREE.Vector3(c.x + Math.cos(a) * domeR * rr, ty, c.z + Math.sin(a) * domeR * rr),
    );
  }

  // Deterministic shuffle: at full density the same sprigs are drawn, but a
  // reduced instance count (adaptive quality) now thins the whole crown
  // evenly instead of dropping whole regions.
  for (let i = sprigs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = sprigs[i];
    sprigs[i] = sprigs[j];
    sprigs[j] = tmp;
  }


  const packed = new Float64Array(sprigs.length * SPRIG_STRIDE);
  sprigs.forEach((c, i) => {
    const o = i * SPRIG_STRIDE;
    packed[o] = c.pos.x;
    packed[o + 1] = c.pos.y;
    packed[o + 2] = c.pos.z;
    packed[o + 3] = c.rot[0];
    packed[o + 4] = c.rot[1];
    packed[o + 5] = c.rot[2];
    packed[o + 6] = c.scl;
    packed[o + 7] = c.shade;
    packed[o + 8] = c.hue;
    packed[o + 9] = c.phase;
  });

  if (!branchGeos.length) return { branch: null, sprigs: packed };
  const merged = mergeGeometries(branchGeos, false);
  return {
    branch: {
      position: merged.getAttribute("position").array as Float32Array,
      normal: merged.getAttribute("normal").array as Float32Array,
      uv: merged.getAttribute("uv").array as Float32Array,
      index: merged.getIndex()!.array as Uint16Array | Uint32Array,
    },
    sprigs: packed,
  };
}
