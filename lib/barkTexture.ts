// Procedural bark: color, bump (height) and roughness maps, seamless around
// the trunk. Pure number crunching (roughly 200 noise lookups per pixel), so it
// runs in the tree worker; see lib/treeWorkerClient.ts.

export type BarkPixels = {
  size: number;
  /** RGBA rows, bottom row first (WebGL order), so they upload without flipping. */
  color: Uint8Array;
  bump: Uint8Array;
  rough: Uint8Array;
};

export function generateBark(size: number): BarkPixels {
  const S = size;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const byte = (n: number) => Math.max(0, Math.min(255, n | 0));
  const smooth = (e0: number, e1: number, x: number) => {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  // Cylindrical noise keeps bark seamless around the trunk.
  const hash3 = (i: number, j: number, k: number) => {
    const x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const vnoise3 = (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = hash3(xi, yi, zi);
    const c100 = hash3(xi + 1, yi, zi);
    const c010 = hash3(xi, yi + 1, zi);
    const c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1);
    const c101 = hash3(xi + 1, yi, zi + 1);
    const c011 = hash3(xi, yi + 1, zi + 1);
    const c111 = hash3(xi + 1, yi + 1, zi + 1);
    return lerp(
      lerp(lerp(c000, c100, u), lerp(c010, c110, u), v),
      lerp(lerp(c001, c101, u), lerp(c011, c111, u), v),
      w,
    );
  };
  const fbm3 = (x: number, y: number, z: number) => {
    let a = 0.5;
    let s = 0;
    for (let k = 0; k < 3; k++) {
      s += a * vnoise3(x, y, z);
      x *= 2.03;
      y *= 2.03;
      z *= 2.03;
      a *= 0.5;
    }
    return s / 0.875;
  };
  const cI = { data: new Uint8Array(S * S * 4) };
  const bI = { data: new Uint8Array(S * S * 4) };
  const rI = { data: new Uint8Array(S * S * 4) };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = x / S;
      const fy = y / S;
      const ang = fy * Math.PI * 2;
      const R = 1.7;
      const cx = Math.cos(ang) * R;
      const cz = Math.sin(ang) * R;
      const up = fx * 6.0;
      // Domain warp creates organic bark variation.
      const nA = fbm3(cx * 0.9 + 1.3, up * 0.9, cz * 0.9) - 0.5;
      const nB = fbm3(cx * 0.9 + 7.7, up * 0.9 + 5.1, cz * 0.9 + 4.4) - 0.5;
      const cxw = cx + nA * 0.7;
      const czw = cz + nB * 0.7;
      const upw = up + (nA + nB) * 0.6;
      const blotch = fbm3(cxw * 0.85, upw * 0.55, czw * 0.85);
      const plate = fbm3(cxw * 1.5, upw * 1.0, czw * 1.5);
      const crackN = fbm3(cxw * 2.3, upw * 2.7, czw * 2.3);
      const ridged = 1 - Math.abs(crackN * 2 - 1);
      const crack = Math.pow(1 - ridged, 2.4);
      const grain = fbm3(cx * 7.5, up * 13.0, cz * 7.5);
      const lich = smooth(0.6, 0.82, blotch);
      // Moss grows on ONE (weather) side of the trunk and thickest near the
      // base — a green fbm gated by azimuth (fy in [0,1] = angle) and height.
      const mossSide = smooth(0.05, 0.4, Math.cos(ang - 1.1) * 0.5 + 0.5);
      const mossLow = 1 - smooth(0.15, 0.55, fx);
      const mossN = smooth(0.45, 0.75, fbm3(cxw * 1.7 + 3.3, upw * 1.2, czw * 1.7));
      const moss = clamp01(mossSide * mossLow * mossN);
      // Height map for bark relief.
      let h = 0.46 + (plate - 0.5) * 0.5 + (blotch - 0.5) * 0.26 - crack * 0.85 + (grain - 0.5) * 0.16;
      h = clamp01(h);
      // Color variation for bark, lichen, and cracks.
      const tone = clamp01(blotch * 0.55 + plate * 0.45);
      let r = lerp(86, 170, tone);
      let g = lerp(56, 116, tone);
      let b = lerp(36, 74, tone);
      r = lerp(r, 150, lich * 0.45);
      g = lerp(g, 156, lich * 0.45);
      b = lerp(b, 128, lich * 0.38);
      r = lerp(r, 32, crack * 0.92);
      g = lerp(g, 23, crack * 0.92);
      b = lerp(b, 15, crack * 0.92);
      // Damp green moss on the weather side.
      r = lerp(r, 74, moss * 0.7);
      g = lerp(g, 92, moss * 0.7);
      b = lerp(b, 48, moss * 0.7);
      const gv = (grain - 0.5) * 22;
      // y runs top-down like the canvas this used to paint; rows are stored
      // bottom-up so a DataTexture shows them the way a CanvasTexture did.
      const idx = ((S - 1 - y) * S + x) * 4;
      cI.data[idx] = byte(r + gv);
      cI.data[idx + 1] = byte(g + gv * 0.7);
      cI.data[idx + 2] = byte(b + gv * 0.4);
      cI.data[idx + 3] = 255;
      const hv = byte(h * 255);
      bI.data[idx] = bI.data[idx + 1] = bI.data[idx + 2] = hv;
      bI.data[idx + 3] = 255;
      const rv = byte(clamp01(0.74 + crack * 0.36 - (plate - 0.5) * 0.14 + moss * 0.2) * 255);
      rI.data[idx] = rI.data[idx + 1] = rI.data[idx + 2] = rv;
      rI.data[idx + 3] = 255;
    }
  }
  return { size, color: cI.data, bump: bI.data, rough: rI.data };
}
