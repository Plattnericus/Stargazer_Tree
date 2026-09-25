// Weather model for the scene. Live mode mirrors Gossensass / Colle Isarco
// conditions as closely as Open-Meteo allows; demo/manual mode uses the same
// shape so render components never need a separate fake-weather path.

import * as THREE from "three";
import { GOSSENSASS } from "./location";
import {
  celestialPosition,
  moonIllumination,
  moonPosition,
  sceneDirection,
  sunPosition,
  zonedDate,
} from "./astro";
import { observerTransmittance, resolveAtmosphere } from "./atmosphere";
import {
  linearToHex,
  rawTransmittance,
  sampleSky,
  sunTransmittance,
  type Atmosphere,
} from "./skyColor";

// Display brightness of the sun disc per unit transmitted sunlight, and its
// cap (HDR: enough to bloom, not enough to flood the frame).
const SUN_DISC_BRIGHTNESS = 0.55;
const SUN_DISC_MAX = 14;
// Direct light on cloud decks per unit transmitted light (display units).
const DECK_LIGHT = 0.034;
// Moonlit-sky exposure at full moon.
const MOON_SKY_EXPOSURE = 0.7;

export { GOSSENSASS };

export type Precip = "none" | "rain" | "snow";
export type Sky = "clear" | "clouds" | "fog" | "rain" | "snow" | "storm";

export type Weather = {
  place?: string;
  tempC: number;
  apparentTempC?: number;
  humidity: number; // %
  pressureHpa: number;
  surfacePressureHpa?: number;
  precipMm: number;
  rainMm: number;
  snowfallCm: number;
  windKmh: number;
  gustKmh: number;
  windDeg?: number; // meteorological direction: wind comes FROM this bearing
  cloud: number; // 0..1 total cloud cover
  cloudLow: number; // 0..1
  cloudMid: number; // 0..1
  cloudHigh: number; // 0..1
  visibilityM: number;
  hour: number; // 0..24 local
  minute?: number; // 0..59 local
  month?: number; // 0..11 (drives season); omitted = use today
  day?: number; // 1..31
  year?: number;
  sky: Sky;
  live: boolean;
  isDay?: boolean; // Open-Meteo is_day, cross-check/display only
  sunrise?: string; // ISO local time from Open-Meteo daily
  sunset?: string;
};

export type CloudLayerParams = {
  density: number; // 0..1, shader density
  coverage: number; // 0..1, actual meteo cover
  height: number;
  thickness: number;
  opacity: number;
  scale: number;
  speed: number;
  detail: number;
};

export type CloudSceneParams = {
  low: CloudLayerParams;
  mid: CloudLayerParams;
  high: CloudLayerParams;
  fog: number;
  visibilityM: number;
  baseColor: string;
  shadowColor: string;
};

// WMO weather_code -> our sky category.
export function skyFromCode(code: number): Sky {
  if (code >= 95) return "storm";
  if (code >= 71 && code <= 77) return "snow";
  if (code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "clouds";
  return "clear";
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export type SceneParams = {
  sunPos: [number, number, number];
  sunIntensity: number;
  sunColor: string;
  sunDisc: [number, number, number]; // HDR linear sun-disc radiance for the dome
  // The shadow-casting key light: the sun by day, the moon at night.
  keyLight: { pos: [number, number, number]; color: string; intensity: number };
  ambient: number;
  skyColor: string;
  fogColor: string; // horizon 90° from the sun
  fogSunColor: string; // horizon toward the sun
  fogAntiColor: string; // horizon away from the sun
  fogNear: number;
  fogFar: number;
  wind: number; // sway multiplier
  gust: number; // short turbulence multiplier
  windKmh: number;
  gustKmh: number;
  windDeg: number; // meteorological direction: wind comes FROM this bearing
  windVec: [number, number]; // normalized scene-space direction the wind moves TO (x,z)
  precip: Precip;
  precipIntensity: number; // 0..1
  dayFactor: number; // 0 night .. 1 noon
  sunElevationDeg: number; // real solar elevation, negative below horizon
  twilight: number; // 0..1, peaks while the sun crosses the horizon
  atmosphere: Atmosphere; // physical sky model inputs (see lib/atmosphere.ts)
  season: Season;
  leafColor: string; // seasonal foliage tint
  snow: number; // 0..1 accumulation on surfaces
  cloud: number; // 0..1 total cover
  clouds: CloudSceneParams;
  cirrus: {
    light: [number, number, number]; // direct sun/moon light on the cirrus deck
    ambient: [number, number, number]; // sky light on the cirrus deck
  };
  galaxy: {
    pole: [number, number, number]; // north galactic pole, scene space
    center: [number, number, number]; // galactic center, scene space
    visible: number; // 0..1
  };
  starsIntensity: number; // 0..1, suppressed by daylight/clouds/fog/precip
  moon: {
    pos: [number, number, number];
    phase: number; // 0=new, 0.5=full, 1=new
    illumination: number; // 0..1
    visible: number; // 0..1
    size: number;
  };
  storm: boolean; // thunderstorm -> lightning
};

// Northern-hemisphere season from month (0-11).
export function seasonFromMonth(month: number): Season {
  if (month <= 1 || month === 11) return "winter";
  if (month <= 4) return "spring";
  if (month <= 7) return "summer";
  return "autumn";
}

const LEAF_COLOR: Record<Season, string> = {
  spring: "#92d64e",
  summer: "#6fc73e",
  autumn: "#e0892f",
  winter: "#9fb0a6",
};

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

function finite(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

export function normalizeWindDeg(deg: number | undefined): number {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return 235;
  return ((deg % 360) + 360) % 360;
}

// Open-Meteo reports meteorological direction (where wind comes FROM). Scene
// motion needs the downwind direction (where particles/clouds/branches move TO).
// Scene convention: +X east, +Z north.
export function windVectorFromDirection(fromDeg: number | undefined): [number, number] {
  const to = ((normalizeWindDeg(fromDeg) + 180) % 360) * THREE.MathUtils.DEG2RAD;
  const x = Math.sin(to);
  const z = Math.cos(to);
  const len = Math.hypot(x, z) || 1;
  return [x / len, z / len];
}

// Distances from the origin for the celestial light anchors. The moon sits
// just inside the star sphere (radius 96 in NightSky) so it draws in front of
// the stars but behind everything else.
const SUN_DISTANCE = 40;
const MOON_DISTANCE = 88;

// dayFactor ramp over real solar elevation: 0 at civil-twilight end (-6°),
// ~0.17 right at sunrise, 1 once the sun is 30°+ up. A low winter noon stays a
// touch dimmer than high summer — that's real light, keep it.
const SIN_TWILIGHT_END = Math.sin(-6 * THREE.MathUtils.DEG2RAD);
const SIN_FULL_DAY = Math.sin(30 * THREE.MathUtils.DEG2RAD);

/** UTC instant for the weather reading's local wall time. */
function sceneDate(w: Weather): Date {
  const now = new Date();
  const year = Math.trunc(finite(w.year, now.getFullYear()));
  const month = Math.trunc(finite(w.month, now.getMonth()));
  const day = Math.trunc(finite(w.day, now.getDate()));
  const hour =
    clamp(finite(w.hour, now.getHours()), 0, 24) +
    clamp(finite(w.minute, 0), 0, 59) / 60;
  return zonedDate(year, month, day, hour, GOSSENSASS.tz);
}

function sunFromDate(date: Date): {
  pos: [number, number, number];
  day: number;
  elevationDeg: number;
  twilight: number;
} {
  const { azimuth, altitude } = sunPosition(date, GOSSENSASS.lat, GOSSENSASS.lon);
  const dir = sceneDirection(azimuth, altitude);
  const sinEl = Math.sin(altitude);
  const day = clamp((sinEl - SIN_TWILIGHT_END) / (SIN_FULL_DAY - SIN_TWILIGHT_END), 0, 1);
  // Warm dawn/dusk band while the sun crosses the horizon (-6°..+8°).
  const rise = THREE.MathUtils.smoothstep(altitude, -0.105, -0.005);
  const fade = 1 - THREE.MathUtils.smoothstep(altitude, 0.02, 0.14);
  const twilight = clamp(rise * fade, 0, 1);
  return {
    pos: [dir[0] * SUN_DISTANCE, dir[1] * SUN_DISTANCE, dir[2] * SUN_DISTANCE],
    day,
    elevationDeg: altitude * THREE.MathUtils.RAD2DEG,
    twilight,
  };
}

function moonFromDate(
  date: Date,
  day: number,
  cloudShadow: number,
  fog: number,
  rainMood: number,
): SceneParams["moon"] {
  const mp = moonPosition(date, GOSSENSASS.lat, GOSSENSASS.lon);
  const ill = moonIllumination(date);
  const dir = sceneDirection(mp.azimuth, mp.altitude);
  // Fade in just past the horizon instead of popping.
  const aboveHorizon = clamp((Math.sin(mp.altitude) - 0.01) / 0.08, 0, 1);
  const weatherVisibility = clamp(1 - cloudShadow * 0.72 - fog * 0.85 - rainMood * 0.7, 0, 1);
  // A daytime moon exists but reads as a faint ghost, not a bright disc.
  const daylightFade = lerp(1, 0.16, day);
  const visible = clamp(
    aboveHorizon * weatherVisibility * daylightFade * (0.18 + ill.fraction * 0.82),
    0,
    1,
  );

  return {
    pos: [dir[0] * MOON_DISTANCE, dir[1] * MOON_DISTANCE, dir[2] * MOON_DISTANCE],
    phase: ill.phase,
    illumination: ill.fraction,
    visible,
    // Real behavior: the apparent size never changes with phase — only with
    // the actual Earth–Moon distance (slightly larger at perigee, "supermoon").
    size: 3.3 * (385000 / Math.max(1, mp.distanceKm)),
  };
}

function cloudLayer(
  coverage: number,
  height: number,
  thickness: number,
  scale: number,
  windKmh: number,
  detail: number,
): CloudLayerParams {
  const cover = clamp(coverage, 0, 1);
  return {
    coverage: cover,
    density: clamp(Math.pow(cover, 1.35), 0, 1),
    height,
    thickness,
    opacity: clamp(0.1 + cover * 0.88, 0, 0.96),
    scale,
    speed: lerp(0.015, 0.1, clamp(windKmh / 55, 0, 1)),
    detail,
  };
}

/** Build realistic scene params from a weather reading. */
export function sceneFromWeather(w: Weather): SceneParams {
  const date = sceneDate(w);
  const { pos, day, elevationDeg, twilight } = sunFromDate(date);
  const humidity = finite(w.humidity, 55);
  const visibilityM = Math.max(100, finite(w.visibilityM, 40000));
  const totalCloud = clamp(finite(w.cloud, 0.2), 0, 1);
  const lowCloud = clamp(finite(w.cloudLow, totalCloud * 0.35), 0, 1);
  const midCloud = clamp(finite(w.cloudMid, totalCloud * 0.55), 0, 1);
  const highCloud = clamp(finite(w.cloudHigh, totalCloud * 0.45), 0, 1);
  const windKmh = Math.max(0, finite(w.windKmh, 0));
  const gustKmh = Math.max(windKmh, finite(w.gustKmh, windKmh));
  const windDeg = normalizeWindDeg(w.windDeg);
  const windVec = windVectorFromDirection(windDeg);
  const gust = clamp((gustKmh - windKmh) / 28, 0, 1.25);

  // Realistic amplitude: no drama multiplier, just enough normalized strength
  // for shaders to read actual mountain-valley wind.
  const wind = clamp(windKmh / 18, 0.06, 2.4);

  const rainy = w.sky === "rain" || w.sky === "storm";
  const snowy = w.sky === "snow" || finite(w.snowfallCm, 0) > 0;
  const precipAmount = finite(w.precipMm, 0) + finite(w.rainMm, 0) + finite(w.snowfallCm, 0) * 1.2;
  const fog = clamp(
    Math.max(
      w.sky === "fog" ? 0.85 : 0,
      (12000 - visibilityM) / 10500,
      humidity > 92 && lowCloud > 0.55 ? lowCloud * 0.55 : 0,
    ),
    0,
    1,
  );

  let precip: Precip = "none";
  let precipIntensity = 0;
  if (rainy) {
    precip = "rain";
    precipIntensity = clamp(0.22 + precipAmount * 0.45 + (w.sky === "storm" ? 0.28 : 0), 0.18, 1);
  } else if (snowy) {
    precip = "snow";
    precipIntensity = clamp(0.22 + finite(w.snowfallCm, 0) * 0.75, 0.18, 0.9);
  }

  const season = seasonFromMonth(w.month ?? new Date().getMonth());
  const snow = snowy ? 0.9 : season === "winter" ? 0.35 : 0;

  const rainMood = rainy ? clamp(0.42 + precipIntensity * 0.45 + (w.sky === "storm" ? 0.18 : 0), 0, 0.95) : 0;
  const cloudShadow = clamp(totalCloud * 0.58 + lowCloud * 0.22 + fog * 0.35 + rainMood * 0.28, 0, 0.98);
  // Cinematic golden hour: the low sun rakes the scene a touch harder.
  // Fades to exactly zero at the end of civil twilight (day = 0), where the
  // moon takes over as key light.
  const sunIntensity =
    (2.05 * day + 0.12 * Math.min(1, day * 10)) *
    (1 + twilight * 0.45) *
    lerp(1, 0.36, cloudShadow) *
    lerp(1, 0.68, rainMood);
  // Stars should be gone by the end of civil twilight, well before sunrise.
  const night = clamp(1 - THREE.MathUtils.smoothstep(day, 0.01, 0.16), 0, 1);
  const starsIntensity = clamp(
    night * (1 - cloudShadow * 0.92) * (1 - fog * 0.9) * (1 - rainMood * 0.82),
    0,
    1,
  );
  const moon = moonFromDate(date, day, cloudShadow, fog, rainMood);

  // Physical atmosphere (lib/atmosphere.ts): the weather drives the aerosols
  // the way it does in real life (humid = milkier, overcast = flat gray,
  // storm = slate). Exposure and the dusk sky light are resolved from the
  // sun's position so the dome, fog and lights share one brightness curve.
  const humidity01 = clamp(humidity / 100, 0, 1);
  const sunDirUnit = new THREE.Vector3(pos[0], pos[1], pos[2]).normalize();
  const moonDirUnit = new THREE.Vector3(moon.pos[0], moon.pos[1], moon.pos[2]).normalize();
  const resolved = resolveAtmosphere([sunDirUnit.x, sunDirUnit.y, sunDirUnit.z], {
    // Cold, dry air scatters a touch deeper blue.
    rayleigh: finite(w.tempC, 12) < 2 ? 1.06 : 1,
    haze: clamp(0.9 + humidity01 * 1.1 + totalCloud * 1.4 + fog * 7 + rainMood * 3, 0.9, 12),
    mieG: 0.8,
    moonExposure: 0,
  });
  const overcast = clamp(cloudShadow * 0.85, 0, 0.92);
  // Moonlit sky: the same scattering lit by the moon. Real moonlight is ~1/400k
  // of sunlight; this is scaled so a full moon gives a faint silver-blue night.
  // Phase counts super-linearly (a half moon is ~1/10 of full in reality).
  const moonSky =
    moonDirUnit.y > -0.1
      ? MOON_SKY_EXPOSURE *
        Math.pow(moon.illumination, 1.5) *
        (1 - THREE.MathUtils.smoothstep(day, 0.04, 0.3))
      : 0;
  const atmosphere: Atmosphere = {
    ...resolved,
    moonExposure: moonSky,
    overcast,
    moodMix: rainMood * 0.75,
    moodColor: w.sky === "storm" ? [0.16, 0.19, 0.26] : [0.35, 0.42, 0.48],
    nightGlow: 1 - overcast * 0.75,
  };

  // Fog/background/light colors are SAMPLED FROM THE SAME ATMOSPHERE the dome
  // renders, so everything always matches the visible sky.
  const sunFlat = Math.hypot(sunDirUnit.x, sunDirUnit.z) > 1e-3
    ? new THREE.Vector3(sunDirUnit.x, 0, sunDirUnit.z).normalize()
    : new THREE.Vector3(1, 0, 0);
  const horizonAt = (x: number, z: number) => new THREE.Vector3(x, 0.05, z).normalize();
  const fogCol = sampleSky(horizonAt(-sunFlat.z, sunFlat.x), sunDirUnit, moonDirUnit, atmosphere);
  const fogSunCol = sampleSky(horizonAt(sunFlat.x, sunFlat.z), sunDirUnit, moonDirUnit, atmosphere);
  const fogAntiCol = sampleSky(horizonAt(-sunFlat.x, -sunFlat.z), sunDirUnit, moonDirUnit, atmosphere);
  const skyDir = new THREE.Vector3(sunFlat.x * 0.22, 0.72, sunFlat.z * 0.22).normalize();
  const skyCol = sampleSky(skyDir, sunDirUnit, moonDirUnit, atmosphere);
  const zenithCol = sampleSky(new THREE.Vector3(0, 1, 0), sunDirUnit, moonDirUnit, atmosphere);
  // Direct sunlight color = atmospheric transmittance (white at noon, amber at
  // the horizon), pulled toward neutral gray under heavy cloud.
  const sunColorLinear = sunTransmittance(sunDirUnit, atmosphere).lerp(
    new THREE.Color("#d4d8dc"),
    clamp(cloudShadow * 0.7, 0, 0.8),
  );
  const sunColor = linearToHex(sunColorLinear);

  // Sun disc radiance for the dome (HDR, so it blooms): what really reaches
  // the eye through the air, hidden by overcast, fog and rain.
  const sunVeil = (1 - overcast * 0.97) * (1 - fog * 0.9) * (1 - rainMood);
  const sunDisc = rawTransmittance(sunDirUnit, atmosphere).multiplyScalar(
    resolved.exposure * SUN_DISC_BRIGHTNESS * sunVeil,
  );
  const discLum = sunDisc.r * 0.2126 + sunDisc.g * 0.7152 + sunDisc.b * 0.0722;
  if (discLum > SUN_DISC_MAX) sunDisc.multiplyScalar(SUN_DISC_MAX / discLum);

  // Light reaching a cloud deck (~3 km for the cumulus, ~9 km for cirrus):
  // clouds stay sunlit a little after sunset and glow pink/orange then.
  const deckLight = (height: number) => {
    const t = observerTransmittance([sunDirUnit.x, sunDirUnit.y, sunDirUnit.z], atmosphere, height);
    const e = resolved.exposure * DECK_LIGHT;
    const m = observerTransmittance([moonDirUnit.x, moonDirUnit.y, moonDirUnit.z], atmosphere, height);
    const me = moonSky * DECK_LIGHT;
    return new THREE.Color(t[0] * e + m[0] * me, t[1] * e + m[1] * me, t[2] * e + m[2] * me);
  };
  const cirrusLight = deckLight(9000);
  const cloudLight = deckLight(3000).multiplyScalar(lerp(1, 0.55, cloudShadow));

  // Key light: the sun by day, the moon by night (with its own shadows).
  // They swap once the sun is ~5° down, where both are equally dim.
  const moonKey =
    moon.visible * (0.25 + moon.illumination * 0.75) * 0.34 *
    (1 - THREE.MathUtils.smoothstep(day, 0, 0.06));
  const moonT = observerTransmittance(
    [moonDirUnit.x, Math.max(moonDirUnit.y, 0.02), moonDirUnit.z],
    atmosphere,
  );
  const moonTMax = Math.max(moonT[0], moonT[1], moonT[2], 1e-6);
  const moonColor = new THREE.Color(0.62, 0.72, 0.98).multiply(
    new THREE.Color(moonT[0] / moonTMax, moonT[1] / moonTMax, moonT[2] / moonTMax),
  );
  const moonKeyWins = moonKey > sunIntensity;
  const keyLight = moonKeyWins
    ? {
        pos: [moon.pos[0], moon.pos[1], moon.pos[2]] as [number, number, number],
        color: linearToHex(moonColor),
        intensity: moonKey,
      }
    : { pos, color: sunColor, intensity: sunIntensity };

  // Twilight pulls the haze in a touch so the glow reads as depth.
  const fogNear = lerp(55, 13, fog) * (1 - twilight * 0.12);
  const fogFar = lerp(135, 42, fog);
  // Volumetric cloud colors from the same light: lit tops take the deck light
  // plus sky light, shaded bases only the sky light (dark at night, pink at
  // dusk, silver under a full moon).
  const skyLight = zenithCol.clone().multiplyScalar(1.15);
  const cloudShade = skyLight.clone().lerp(fogCol, 0.35).multiplyScalar(lerp(0.9, 0.6, cloudShadow));
  const cloudBase = cloudShade.clone().add(cloudLight);
  // Foliage warms in the golden hour (sunlit leaves read amber in real life).
  const leafColor =
    "#" +
    new THREE.Color(LEAF_COLOR[season])
      .lerp(new THREE.Color("#d8a24a"), twilight * 0.28)
      .getHexString();

  // Milky Way: the real galactic plane over the location at this moment,
  // washed out by moonlight, clouds and anything but a dark night.
  const galaxyDir = (raDeg: number, decDeg: number) => {
    const p = celestialPosition(date, GOSSENSASS.lat, GOSSENSASS.lon, raDeg * THREE.MathUtils.DEG2RAD, decDeg * THREE.MathUtils.DEG2RAD);
    return sceneDirection(p.azimuth, p.altitude);
  };
  const moonGlare = clamp(moonDirUnit.y * 6, 0, 1) * moon.illumination;
  const galaxyVisible = starsIntensity * (1 - moonGlare * 0.85);

  return {
    sunPos: pos,
    sunIntensity,
    sunColor,
    sunDisc: [sunDisc.r, sunDisc.g, sunDisc.b],
    keyLight,
    // The physical sky color is bright, so the hemisphere intensity is kept
    // low to hold a sensible light energy.
    ambient: (lerp(0.12, 0.36, day) + totalCloud * 0.05) * lerp(1, 0.72, rainMood),
    skyColor: linearToHex(skyCol),
    fogColor: linearToHex(fogCol),
    fogSunColor: linearToHex(fogSunCol),
    fogAntiColor: linearToHex(fogAntiCol),
    fogNear,
    fogFar,
    wind,
    gust,
    windKmh,
    gustKmh,
    windDeg,
    windVec,
    precip,
    precipIntensity,
    dayFactor: day,
    sunElevationDeg: elevationDeg,
    twilight,
    atmosphere,
    season,
    leafColor,
    snow,
    cloud: totalCloud,
    clouds: {
      low: cloudLayer(Math.max(lowCloud, fog * 0.35), 18, 10, 0.075, windKmh, 0.92),
      mid: cloudLayer(midCloud, 32, 16, 0.052, windKmh, 1.0),
      high: cloudLayer(highCloud, 52, 11, 0.032, windKmh * 1.25, 1.35),
      fog,
      visibilityM,
      baseColor: linearToHex(cloudBase),
      shadowColor: linearToHex(cloudShade),
    },
    cirrus: {
      light: [cirrusLight.r, cirrusLight.g, cirrusLight.b],
      ambient: [zenithCol.r * 0.9, zenithCol.g * 0.9, zenithCol.b * 0.9],
    },
    galaxy: {
      pole: galaxyDir(192.8595, 27.1283),
      center: galaxyDir(266.405, -28.936),
      visible: galaxyVisible,
    },
    starsIntensity,
    moon,
    storm: w.sky === "storm",
  };
}

// Manual presets for the settings menu. These are demo fixtures, but they keep
// realistic ranges and the same shape as live Open-Meteo readings.
export function manualWeather(hour: number, month: number, sky: Sky, year?: number, day?: number): Weather {
  const now = new Date();
  const tempC = sky === "snow" ? -3 : sky === "clear" ? 22 : 12;
  const windKmh = sky === "storm" ? 38 : sky === "clouds" ? 16 : sky === "fog" ? 3 : 8;
  const gustKmh = sky === "storm" ? 58 : windKmh + 8;
  const windDeg =
    sky === "storm" ? 235 : sky === "rain" ? 210 : sky === "snow" ? 20 : sky === "fog" ? 120 : 255;
  const cloud =
    sky === "clear" ? 0.08 : sky === "clouds" ? 0.72 : sky === "fog" ? 0.92 : 1;
  const cloudLow = sky === "fog" ? 0.95 : sky === "rain" || sky === "snow" || sky === "storm" ? 0.8 : cloud * 0.28;
  const cloudMid = sky === "clear" ? 0.08 : sky === "clouds" ? 0.7 : 0.86;
  const cloudHigh = sky === "clear" ? 0.15 : sky === "storm" ? 0.7 : 0.55;
  return {
    place: GOSSENSASS.place,
    tempC,
    apparentTempC: tempC,
    humidity: sky === "fog" ? 97 : sky === "clear" ? 45 : 72,
    pressureHpa: sky === "storm" ? 1004 : 1018,
    surfacePressureHpa: sky === "storm" ? 895 : 905,
    precipMm: sky === "rain" || sky === "storm" ? 1.2 : 0,
    rainMm: sky === "rain" || sky === "storm" ? 1.2 : 0,
    snowfallCm: sky === "snow" ? 0.6 : 0,
    windKmh,
    gustKmh,
    windDeg,
    cloud,
    cloudLow,
    cloudMid,
    cloudHigh,
    visibilityM: sky === "fog" ? 2200 : sky === "snow" ? 9000 : 38000,
    hour,
    month,
    day: day ?? now.getDate(),
    year: year ?? now.getFullYear(),
    sky,
    live: false,
  };
}

export function weatherFromApiPayload(payload: Record<string, unknown>): Weather {
  return {
    place: typeof payload.place === "string" ? payload.place : GOSSENSASS.place,
    tempC: finite(payload.tempC as number | undefined, 12),
    apparentTempC: finite(payload.apparentTempC as number | undefined, 12),
    humidity: finite(payload.humidity as number | undefined, 55),
    pressureHpa: finite(payload.pressureHpa as number | undefined, 1016),
    surfacePressureHpa: finite(payload.surfacePressureHpa as number | undefined, 905),
    precipMm: finite(payload.precipMm as number | undefined, 0),
    rainMm: finite(payload.rainMm as number | undefined, 0),
    snowfallCm: finite(payload.snowfallCm as number | undefined, 0),
    windKmh: finite(payload.windKmh as number | undefined, 6),
    gustKmh: finite(payload.gustKmh as number | undefined, finite(payload.windKmh as number | undefined, 6)),
    windDeg: finite(payload.windDeg as number | undefined, 235),
    cloud: clamp(finite(payload.cloud as number | undefined, 0.3), 0, 1),
    cloudLow: clamp(finite(payload.cloudLow as number | undefined, 0.1), 0, 1),
    cloudMid: clamp(finite(payload.cloudMid as number | undefined, 0.3), 0, 1),
    cloudHigh: clamp(finite(payload.cloudHigh as number | undefined, 0.2), 0, 1),
    visibilityM: finite(payload.visibilityM as number | undefined, 40000),
    hour: finite(payload.hour as number | undefined, 12),
    minute: finite(payload.minute as number | undefined, 0),
    month: finite(payload.month as number | undefined, new Date().getMonth()),
    day: finite(payload.day as number | undefined, new Date().getDate()),
    year: finite(payload.year as number | undefined, new Date().getFullYear()),
    sky: (typeof payload.sky === "string" ? payload.sky : "clear") as Sky,
    live: Boolean(payload.live),
    isDay: typeof payload.isDay === "boolean" ? payload.isDay : undefined,
    sunrise: typeof payload.sunrise === "string" ? payload.sunrise : undefined,
    sunset: typeof payload.sunset === "string" ? payload.sunset : undefined,
  };
}

