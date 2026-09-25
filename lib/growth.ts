// Growth math. The tree is a spiral tower: each star adds a platform up a helix
// and the trunk and crown grow taller to make room.

import { slotHeight } from "./bonsai";

/** Height of the top (newest) active platform — the structural top of the tower. */
function topPlatformY(stars: number): number {
  const active = Math.max(0, Math.floor(stars));
  return active <= 0 ? 2 : slotHeight(active - 1);
}

/** The crown APEX — foliage reaches this high, ABOVE the trunk tip (so the trunk
 *  never pokes out bare). Drives the camera framing. */
export function treeHeight(stars: number): number {
  return topPlatformY(stars) + 4.2;
}

/** Where the TRUNK tip ends — just above the top platform and INSIDE the crown,
 *  so the rounded crown caps it. */
export function trunkHeight(stars: number): number {
  return topPlatformY(stars) + 1.2;
}

/** Trunk base radius — thin & clean, always < the 5.2 helix radius so it never
 *  pokes through a platform. */
export function trunkBaseRadius(stars: number): number {
  const H = trunkHeight(stars);
  return Math.min(1.4, Math.max(0.45, 0.45 + H * 0.02));
}
