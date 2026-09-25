// Physically based atmosphere: single scattering through a spherical Earth
// atmosphere with Rayleigh molecules, Mie aerosols and an ozone layer, plus a
// cheap isotropic multiple-scattering term. Unlike the Preetham fit it used to
// replace, this stays right below the horizon: the twilight glow, the blue
// hour (ozone keeps the zenith blue while the sun is down), the Earth's shadow
// rising in the east and a moonlit night all fall out of the same integral.
//
// The GPU evaluates it into a small sky-view LUT (components/Sky.tsx) only
// when the sun, moon or weather actually change, so the dome costs one texture
// fetch per pixel. The JS port below runs the SAME math (same constants, same
// sample layout) for the few directions the scene needs on the CPU: fog,
// hemisphere light, sun and moon light colors. Keep both halves in sync.
//
// Output is "display-linear": radiance times an exposure that compresses the
// real 10^6 range between noon and night into something a fixed tone mapper
// can show (see skyExposure), then blended toward overcast/storm like before.

// Units: meters.
export const EARTH_RADIUS = 6360e3;
export const ATMOSPHERE_RADIUS = 6460e3;
export const OBSERVER_HEIGHT = 250;
const RAYLEIGH_SCALE_HEIGHT = 8000;
const MIE_SCALE_HEIGHT = 1200;
const RAYLEIGH_SCATTER: Vec3 = [5.802e-6, 13.558e-6, 33.1e-6];
const MIE_SCATTER = 3.996e-6;
const MIE_EXTINCTION = MIE_SCATTER / 0.9;
// Chappuis-band ozone absorption. Red is raised over the usual RGB fit
// (0.65e-6): three channels undersample the band's long red tail, and without
// it the blue hour comes out violet instead of the deep blue it really is.
const OZONE_ABSORB: Vec3 = [1.5e-6, 1.881e-6, 0.085e-6];
// Share of single scattering re-added as isotropic multiple scattering: fills
// the anti-sun sky and softens the Earth's shadow edge the way real skies do.
const MULTI_SCATTER = 0.32;
export const VIEW_SAMPLES = 20;
const SCOTOPIC_TINT: Vec3 = [0.62, 0.76, 1.08];
const SCOTOPIC_KEEP = 0.25;
const SHADOW_SOFT = 7000;
export const LIGHT_SAMPLES = 6;

type Vec3 = [number, number, number];

export type AtmosphereInputs = {
  rayleigh: number; // molecular density multiplier (1 = standard air)
  haze: number; // aerosol density multiplier (1 = clean alpine air)
  mieG: number; // aerosol anisotropy (forward glow around the sun)
  exposure: number; // display scale for sunlight (see skyExposure)
  moonExposure: number; // display scale for moonlight (0 = no moon)
  // Isotropic light from the rest of the sky (raw units, see skyAmbient).
  // It lights air the direct sun can't reach, e.g. inside the Earth's
  // shadow at dusk, so that band reads dusky blue instead of black.
  ambient: [number, number, number];
};

// ---------------------------------------------------------------------------
// GLSL. Expects: uniform float uRayleigh, uHaze, uMieG, uExposure, uMoonExposure;
// uniform vec3 uAmbient.
export const ATMOSPHERE_GLSL = /* glsl */ `
  const float PI_A = 3.14159265359;
  const float R_E = ${EARTH_RADIUS.toFixed(1)};
  const float R_A = ${ATMOSPHERE_RADIUS.toFixed(1)};
  const float H0 = ${OBSERVER_HEIGHT.toFixed(1)};
  const vec3 SIGMA_R = vec3(${RAYLEIGH_SCATTER.map((v) => v.toExponential(4)).join(", ")});
  const float SIGMA_MS = ${MIE_SCATTER.toExponential(4)};
  const float SIGMA_ME = ${MIE_EXTINCTION.toExponential(4)};
  const vec3 SIGMA_O = vec3(${OZONE_ABSORB.map((v) => v.toExponential(4)).join(", ")});
  const float MS_K = ${MULTI_SCATTER.toFixed(3)};

  // Far intersection distance with a sphere of radius r centred on the planet.
  float atmoExit(vec3 p, vec3 d, float r) {
    float b = dot(p, d);
    float c = dot(p, p) - r * r;
    return -b + sqrt(max(b * b - c, 0.0));
  }

  // Rayleigh, Mie and ozone densities at altitude h.
  vec3 atmoDensity(float h) {
    h = max(h, 0.0);
    return vec3(
      exp(-h / ${RAYLEIGH_SCALE_HEIGHT.toFixed(1)}),
      exp(-h / ${MIE_SCALE_HEIGHT.toFixed(1)}),
      max(0.0, 1.0 - abs(h - 25000.0) / 15000.0)
    );
  }

  vec3 atmoExtinction(vec3 od) {
    return SIGMA_R * (uRayleigh * od.x) + vec3(SIGMA_ME * uHaze * od.y) + SIGMA_O * od.z;
  }

  // Transmittance from p toward the light, with a soft Earth shadow: a ray
  // whose closest approach dips up to SHADOW_SOFT below the ground still
  // carries some light (refraction bends it around the limb), so twilight has
  // no hard terminator. Rays that never approach the ground are unshadowed.
  vec3 atmoLight(vec3 p, vec3 l) {
    float b = dot(p, l);
    float closest = b < 0.0 ? sqrt(max(dot(p, p) - b * b, 0.0)) : R_E;
    float shadow = smoothstep(R_E - ${SHADOW_SOFT.toFixed(1)}, R_E, closest);
    if (shadow <= 0.0) return vec3(0.0);
    float len = atmoExit(p, l, R_A);
    float dt = len / ${LIGHT_SAMPLES.toFixed(1)};
    vec3 od = vec3(0.0);
    for (int i = 0; i < ${LIGHT_SAMPLES}; i++) {
      vec3 q = p + l * ((float(i) + 0.5) * dt);
      od += atmoDensity(length(q) - R_E);
    }
    return exp(-atmoExtinction(od * dt)) * shadow;
  }

  // Night vision is rod vision: nearly colorless with a blue cast (Purkinje
  // shift). Moonlit sky keeps only a trace of its real color, so a setting
  // moon reads as a silver glow instead of a small orange sunset.
  vec3 atmoScotopic(vec3 c) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(l * vec3(${SCOTOPIC_TINT.map((v) => v.toFixed(3)).join(", ")}), c, ${SCOTOPIC_KEEP.toFixed(3)});
  }

  float atmoPhaseR(float mu) { return 3.0 / (16.0 * PI_A) * (1.0 + mu * mu); }
  float atmoPhaseM(float mu, float g) {
    float g2 = g * g;
    return 3.0 / (8.0 * PI_A) * (1.0 - g2) * (1.0 + mu * mu)
      / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  // Sky radiance toward d (unit, world, y up), already exposed for display.
  vec3 atmoSky(vec3 d, vec3 sunDir, vec3 moonDir) {
    vec3 ro = vec3(0.0, R_E + H0, 0.0);
    float tMax = atmoExit(ro, d, R_A);
    bool moonOn = uMoonExposure > 0.0;
    vec3 odAcc = vec3(0.0);
    vec3 sR = vec3(0.0), sM = vec3(0.0), mR = vec3(0.0), mM = vec3(0.0);
    vec3 aR = vec3(0.0), aM = vec3(0.0);
    for (int i = 0; i < ${VIEW_SAMPLES}; i++) {
      float a = float(i) / ${VIEW_SAMPLES.toFixed(1)};
      float b = float(i + 1) / ${VIEW_SAMPLES.toFixed(1)};
      float t0 = tMax * a * a;
      float t1 = tMax * b * b;
      float ds = t1 - t0;
      vec3 p = ro + d * (0.5 * (t0 + t1));
      vec3 dens = atmoDensity(length(p) - R_E);
      vec3 tView = exp(-atmoExtinction(odAcc + dens * (0.5 * ds)));
      odAcc += dens * ds;
      aR += tView * (ds * dens.x);
      aM += tView * (ds * dens.y);
      vec3 ts = atmoLight(p, sunDir) * tView * ds;
      sR += ts * dens.x;
      sM += ts * dens.y;
      if (moonOn) {
        vec3 tm = atmoLight(p, moonDir) * tView * ds;
        mR += tm * dens.x;
        mM += tm * dens.y;
      }
    }
    vec3 rS = SIGMA_R * uRayleigh;
    float mS = SIGMA_MS * uHaze;
    float muS = dot(d, sunDir);
    vec3 col = (rS * sR * (atmoPhaseR(muS) + MS_K / (4.0 * PI_A))
      + mS * sM * (atmoPhaseM(muS, uMieG) + MS_K / (4.0 * PI_A))
      + (rS * aR + mS * aM) * uAmbient) * uExposure;
    if (moonOn) {
      float muM = dot(d, moonDir);
      vec3 moonCol = (rS * mR * (atmoPhaseR(muM) + MS_K / (4.0 * PI_A))
        + mS * mM * (atmoPhaseM(muM, uMieG) + MS_K / (4.0 * PI_A))) * uMoonExposure;
      col += atmoScotopic(moonCol);
    }
    return col;
  }

  // Transmittance from the observer toward a light (sun disc / moon color).
  vec3 atmoObserverLight(vec3 l) {
    return atmoLight(vec3(0.0, R_E + H0, 0.0), l);
  }
`;

// ---------------------------------------------------------------------------
// JS port (identical math).

function exitDist(px: number, py: number, pz: number, dx: number, dy: number, dz: number, r: number) {
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - r * r;
  return -b + Math.sqrt(Math.max(b * b - c, 0));
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function density(h: number, out: Vec3): Vec3 {
  const hh = Math.max(h, 0);
  out[0] = Math.exp(-hh / RAYLEIGH_SCALE_HEIGHT);
  out[1] = Math.exp(-hh / MIE_SCALE_HEIGHT);
  out[2] = Math.max(0, 1 - Math.abs(hh - 25000) / 15000);
  return out;
}

function extinction(odR: number, odM: number, odO: number, a: AtmosphereInputs, out: Vec3): Vec3 {
  for (let c = 0; c < 3; c++) {
    out[c] = RAYLEIGH_SCATTER[c] * a.rayleigh * odR + MIE_EXTINCTION * a.haze * odM + OZONE_ABSORB[c] * odO;
  }
  return out;
}

const _d: Vec3 = [0, 0, 0];
const _e: Vec3 = [0, 0, 0];

function lightTransmittance(
  px: number,
  py: number,
  pz: number,
  l: Vec3,
  a: AtmosphereInputs,
  out: Vec3,
): Vec3 {
  const b = px * l[0] + py * l[1] + pz * l[2];
  const closest =
    b < 0 ? Math.sqrt(Math.max(px * px + py * py + pz * pz - b * b, 0)) : EARTH_RADIUS;
  const shadow = smoothstep(EARTH_RADIUS - SHADOW_SOFT, EARTH_RADIUS, closest);
  if (shadow <= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const len = exitDist(px, py, pz, l[0], l[1], l[2], ATMOSPHERE_RADIUS);
  const dt = len / LIGHT_SAMPLES;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < LIGHT_SAMPLES; i++) {
    const t = (i + 0.5) * dt;
    const qx = px + l[0] * t;
    const qy = py + l[1] * t;
    const qz = pz + l[2] * t;
    density(Math.sqrt(qx * qx + qy * qy + qz * qz) - EARTH_RADIUS, _d);
    odR += _d[0];
    odM += _d[1];
    odO += _d[2];
  }
  extinction(odR * dt, odM * dt, odO * dt, a, _e);
  out[0] = Math.exp(-_e[0]) * shadow;
  out[1] = Math.exp(-_e[1]) * shadow;
  out[2] = Math.exp(-_e[2]) * shadow;
  return out;
}

function phaseR(mu: number) {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

function phaseM(mu: number, g: number) {
  const g2 = g * g;
  return (
    ((3 / (8 * Math.PI)) * (1 - g2) * (1 + mu * mu)) /
    ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5))
  );
}

const _ts: Vec3 = [0, 0, 0];
const _tv: Vec3 = [0, 0, 0];

/**
 * Display-linear sky radiance toward the unit direction d (+Y up). Directions
 * below the horizon are not meaningful here (the dome clamps them).
 */
export function atmosphereSky(
  d: Vec3,
  sunDir: Vec3,
  moonDir: Vec3,
  a: AtmosphereInputs,
): Vec3 {
  const ox = 0;
  const oy = EARTH_RADIUS + OBSERVER_HEIGHT;
  const oz = 0;
  const tMax = exitDist(ox, oy, oz, d[0], d[1], d[2], ATMOSPHERE_RADIUS);
  const moonOn = a.moonExposure > 0;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  const sR: Vec3 = [0, 0, 0];
  const sM: Vec3 = [0, 0, 0];
  const mR: Vec3 = [0, 0, 0];
  const mM: Vec3 = [0, 0, 0];
  const aR: Vec3 = [0, 0, 0];
  const aM: Vec3 = [0, 0, 0];
  for (let i = 0; i < VIEW_SAMPLES; i++) {
    const fa = i / VIEW_SAMPLES;
    const fb = (i + 1) / VIEW_SAMPLES;
    const t0 = tMax * fa * fa;
    const t1 = tMax * fb * fb;
    const ds = t1 - t0;
    const t = 0.5 * (t0 + t1);
    const px = ox + d[0] * t;
    const py = oy + d[1] * t;
    const pz = oz + d[2] * t;
    density(Math.sqrt(px * px + py * py + pz * pz) - EARTH_RADIUS, _d);
    const dR = _d[0];
    const dM = _d[1];
    const dO = _d[2];
    extinction(odR + dR * 0.5 * ds, odM + dM * 0.5 * ds, odO + dO * 0.5 * ds, a, _e);
    _tv[0] = Math.exp(-_e[0]);
    _tv[1] = Math.exp(-_e[1]);
    _tv[2] = Math.exp(-_e[2]);
    odR += dR * ds;
    odM += dM * ds;
    odO += dO * ds;
    for (let c = 0; c < 3; c++) {
      aR[c] += _tv[c] * ds * dR;
      aM[c] += _tv[c] * ds * dM;
    }
    lightTransmittance(px, py, pz, sunDir, a, _ts);
    for (let c = 0; c < 3; c++) {
      const s = _ts[c] * _tv[c] * ds;
      sR[c] += s * dR;
      sM[c] += s * dM;
    }
    if (moonOn) {
      lightTransmittance(px, py, pz, moonDir, a, _ts);
      for (let c = 0; c < 3; c++) {
        const s = _ts[c] * _tv[c] * ds;
        mR[c] += s * dR;
        mM[c] += s * dM;
      }
    }
  }
  const ms = MULTI_SCATTER / (4 * Math.PI);
  const muS = d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2];
  const pRS = phaseR(muS) + ms;
  const pMS = phaseM(muS, a.mieG) + ms;
  const muM = d[0] * moonDir[0] + d[1] * moonDir[1] + d[2] * moonDir[2];
  const pRM = phaseR(muM) + ms;
  const pMM = phaseM(muM, a.mieG) + ms;
  const out: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const rS = RAYLEIGH_SCATTER[c] * a.rayleigh;
    const mS = MIE_SCATTER * a.haze;
    out[c] = (rS * sR[c] * pRS + mS * sM[c] * pMS + (rS * aR[c] + mS * aM[c]) * a.ambient[c]) * a.exposure;
  }
  if (moonOn) {
    const m: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      m[c] = (RAYLEIGH_SCATTER[c] * a.rayleigh * mR[c] * pRM + MIE_SCATTER * a.haze * mM[c] * pMM) * a.moonExposure;
    }
    const l = luminance(m);
    for (let c = 0; c < 3; c++) {
      out[c] += l * SCOTOPIC_TINT[c] + (m[c] - l * SCOTOPIC_TINT[c]) * SCOTOPIC_KEEP;
    }
  }
  return out;
}

/**
 * Transmittance toward a light direction (unit, +Y up) from the observer, or
 * from `height` meters above the ground (e.g. a cloud deck).
 */
export function observerTransmittance(l: Vec3, a: AtmosphereInputs, height = OBSERVER_HEIGHT): Vec3 {
  return lightTransmittance(0, EARTH_RADIUS + height, 0, l, a, [0, 0, 0]);
}

/**
 * Isotropic sky light for AtmosphereInputs.ambient: the average brightness of
 * the lit sky, which keeps shining on air the direct sun has left. This is the
 * multiple scattering that keeps a real nautical-twilight sky blue long after
 * single scattering alone would have gone black. While the sun is up
 * MULTI_SCATTER already covers it, so it only fades in as the sun sets.
 */
export function skyAmbient(rawAverage: Vec3, sunY: number): Vec3 {
  const k = AMBIENT_K * (1 - smoothstep(-0.03, 0.08, sunY));
  return [rawAverage[0] * k, rawAverage[1] * k, rawAverage[2] * k];
}
const AMBIENT_K = 1.0;

// Real sky brightness spans ~10^6 between noon and a moonless night; eyes
// adapt, a fixed tone mapper can't. So the display follows the real average
// sky brightness only to the power (1 - EXPOSURE_POWER): dusk and the blue hour
// stay readable, and the order of events (golden hour, blue hour, night) is
// kept. The cap is where adaptation "gives up" and night falls.
const EXPOSURE_TARGET = 0.34;
const EXPOSURE_POWER = 0.7;
const EXPOSURE_REFERENCE = 0.02; // raw average sky luminance with a high sun
const EXPOSURE_MAX = 9000;

/** Exposure for the sun term from the raw (unexposed) average sky luminance. */
export function skyExposure(rawAverageLuminance: number): number {
  const rel = Math.max(rawAverageLuminance / EXPOSURE_REFERENCE, 1e-9);
  return Math.min(EXPOSURE_MAX, (EXPOSURE_TARGET / EXPOSURE_REFERENCE) * Math.pow(rel, -EXPOSURE_POWER));
}

// Directions averaged for the exposure: zenith, a ring at 45° and a ring just
// above the horizon (where the twilight glow lives).
const EXPOSURE_DIRS: Vec3[] = (() => {
  const dirs: Vec3[] = [[0, 1, 0]];
  for (const [el, n] of [[45, 4], [8, 8]] as const) {
    const r = (el * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      const az = ((i + 0.5) / n) * Math.PI * 2;
      dirs.push([Math.sin(az) * Math.cos(r), Math.sin(r), Math.cos(az) * Math.cos(r)]);
    }
  }
  return dirs;
})();

/**
 * Resolves the exposure and ambient inputs for a sun direction: evaluates the
 * raw sky (sun only) and returns `a` with exposure/ambient filled in.
 */
export function resolveAtmosphere(
  sunDir: Vec3,
  a: Omit<AtmosphereInputs, "exposure" | "ambient">,
): AtmosphereInputs {
  const raw: AtmosphereInputs = { ...a, exposure: 1, moonExposure: 0, ambient: [0, 0, 0] };
  const average = (): Vec3 => {
    const sum: Vec3 = [0, 0, 0];
    for (const d of EXPOSURE_DIRS) {
      const c = atmosphereSky(d, sunDir, sunDir, raw);
      sum[0] += c[0];
      sum[1] += c[1];
      sum[2] += c[2];
    }
    const n = EXPOSURE_DIRS.length;
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  };
  raw.ambient = skyAmbient(average(), sunDir[1]);
  return { ...a, ambient: raw.ambient, exposure: skyExposure(luminance(average())) };
}

export function luminance(c: Vec3): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

// Night-sky floor in display units: airglow and starlight, brighter toward
// the horizon where the line of sight crosses more glowing air (van Rhijn).
// Shared by the GLSL (AIRGLOW_GLSL) and the JS samplers.
export const AIRGLOW: Vec3 = [0.003, 0.0046, 0.0095];
export function airglow(elevationSin: number): number {
  const s = 1 - Math.max(0, Math.min(1, elevationSin));
  return 1 + 1.8 * s * s * s;
}
export const AIRGLOW_GLSL = /* glsl */ `
  vec3 atmoAirglow(float elevationSin) {
    float s = 1.0 - clamp(elevationSin, 0.0, 1.0);
    return vec3(${AIRGLOW.map((v) => v.toFixed(5)).join(", ")}) * (1.0 + 1.8 * s * s * s);
  }
`;
