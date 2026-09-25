import * as THREE from "three";
import {
  AIRGLOW,
  airglow,
  atmosphereSky,
  observerTransmittance,
  type AtmosphereInputs,
} from "./atmosphere";

// The sky as the scene sees it: the physical atmosphere (lib/atmosphere.ts)
// plus the weather layer on top (overcast deck, rain/storm tint, airglow).
// sampleSky() here and the dome's LUT shader (components/Sky.tsx) apply the
// weather identically, so fog, background and light colors sampled here always
// match the visible sky.
//
// All colors returned here are LINEAR; convert with linearToHex for storage.

export type Atmosphere = AtmosphereInputs & {
  overcast: number; // 0..1 flatten toward a neutral gray cloud deck
  moodMix: number; // 0..1 rain/storm tint blend
  moodColor: [number, number, number]; // linear rain/storm tint
  nightGlow: number; // 0..1 airglow visibility (clouds hide it)
};

// Stylized sun: ~4x the real 0.27° radius reads better at scene scale.
export const SUN_DISC_RADIUS = 0.0175;

// Soft knee on sky luminance: values above KNEE roll off toward KNEE + SPAN,
// so the low sun's horizon glow stays a glow instead of a white flood. Below
// the knee the sky is untouched. Mirrored by WEATHER_GLSL.
const KNEE = 0.6;
const SPAN = 0.8;

// Weather layer, mirrored by WEATHER_GLSL.
function applyWeather(c: [number, number, number], dirY: number, a: Atmosphere): [number, number, number] {
  let lum = c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  if (lum > KNEE) {
    const over = lum - KNEE;
    const scale = (KNEE + over / (1 + over / SPAN)) / lum;
    c = [c[0] * scale, c[1] * scale, c[2] * scale];
    lum *= scale;
  }
  const oc = THREE.MathUtils.clamp(a.overcast, 0, 1);
  const mood = THREE.MathUtils.clamp(a.moodMix, 0, 1);
  const glow = airglow(dirY) * a.nightGlow;
  const out: [number, number, number] = [0, 0, 0];
  const deck = [0.92, 0.96, 1.0];
  for (let i = 0; i < 3; i++) {
    let v = c[i] + (lum * deck[i] - c[i]) * oc;
    v += (a.moodColor[i] * lum * 2.4 - v) * mood;
    out[i] = v + AIRGLOW[i] * glow;
  }
  return out;
}

export const WEATHER_GLSL = /* glsl */ `
  vec3 applyWeather(vec3 c, float dirY) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (lum > ${KNEE.toFixed(3)}) {
      float over = lum - ${KNEE.toFixed(3)};
      float scale = (${KNEE.toFixed(3)} + over / (1.0 + over / ${SPAN.toFixed(3)})) / lum;
      c *= scale;
      lum *= scale;
    }
    c = mix(c, lum * vec3(0.92, 0.96, 1.0), uOvercast);
    c = mix(c, uMoodColor * (lum * 2.4), uMood);
    return c + atmoAirglow(dirY) * uNightGlow;
  }
`;

const _dir: [number, number, number] = [0, 0, 0];

/**
 * Sky color toward a view direction (+Y up; below-horizon directions use the
 * horizon, like the dome). `sunDir`/`moonDir` are unit world directions.
 */
export function sampleSky(
  dir: THREE.Vector3,
  sunDir: THREE.Vector3,
  moonDir: THREE.Vector3,
  a: Atmosphere,
): THREE.Color {
  _dir[0] = dir.x;
  _dir[1] = Math.max(dir.y, 0);
  _dir[2] = dir.z;
  const len = Math.hypot(_dir[0], _dir[1], _dir[2]) || 1;
  _dir[0] /= len;
  _dir[1] /= len;
  _dir[2] /= len;
  const c = atmosphereSky(_dir, [sunDir.x, sunDir.y, sunDir.z], [moonDir.x, moonDir.y, moonDir.z], a);
  const w = applyWeather(c, _dir[1], a);
  return new THREE.Color(
    THREE.MathUtils.clamp(w[0], 0, 4),
    THREE.MathUtils.clamp(w[1], 0, 4),
    THREE.MathUtils.clamp(w[2], 0, 4),
  );
}

/**
 * Color of direct sunlight after crossing the atmosphere toward `sunDir`
 * (transmittance): white at noon, amber near the horizon. Normalized so the
 * light INTENSITY stays a separate control. The sun is held at >= 1° so the
 * color stays defined (and warm) while it sets.
 */
export function sunTransmittance(sunDir: THREE.Vector3, a: Atmosphere): THREE.Color {
  const minY = Math.sin(1 * THREE.MathUtils.DEG2RAD);
  const y = Math.max(sunDir.y, minY);
  const h = Math.hypot(sunDir.x, sunDir.z) || 1;
  const s = Math.sqrt(1 - y * y) / h;
  const t = observerTransmittance([sunDir.x * s, y, sunDir.z * s], a);
  const m = Math.max(t[0], t[1], t[2], 1e-6);
  return new THREE.Color(t[0] / m, t[1] / m, t[2] / m);
}

/** Raw (unnormalized) transmittance toward a direction, 0 below the horizon. */
export function rawTransmittance(dir: THREE.Vector3, a: Atmosphere): THREE.Color {
  const t = observerTransmittance([dir.x, dir.y, dir.z], a);
  return new THREE.Color(t[0], t[1], t[2]);
}

/**
 * Linear color -> sRGB hex string (for SceneParams). THREE.Color already holds
 * linear working-space values and getHexString() encodes them to sRGB, so no
 * extra convertLinearToSRGB() here: that would encode twice and wash every
 * sampled color out (a gray night fog under a black sky).
 */
export function linearToHex(c: THREE.Color): string {
  return "#" + c.getHexString(THREE.SRGBColorSpace);
}
