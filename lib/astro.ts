// Real astronomical positions for the sun and moon, so scene lighting matches
// the actual sky over the tracked location at any date/time (live or manual).
//
// Low-precision Meeus/NOAA formulas (the same family suncalc uses), accurate to
// a fraction of a degree — far below anything visible in the scene.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;

// Days since J2000.0 (2000-01-01 12:00 UTC).
function toDays(date: Date): number {
  return date.getTime() / DAY_MS - 10957.5;
}

// Obliquity of the ecliptic.
const OBLIQUITY = 23.4397 * RAD;

function rightAscension(l: number, b: number): number {
  return Math.atan2(
    Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY),
    Math.cos(l),
  );
}

function declination(l: number, b: number): number {
  return Math.asin(
    Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l),
  );
}

// Azimuth measured from SOUTH, positive westward (converted for the scene in
// sceneDirection below). Altitude above the horizon, in radians.
function azimuthFromSouth(H: number, phi: number, dec: number): number {
  return Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
}

function altitudeAbove(H: number, phi: number, dec: number): number {
  return Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
}

function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372; // perihelion of Earth
  return M + C + P + Math.PI;
}

function sunCoords(d: number): { ra: number; dec: number } {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { ra: rightAscension(L, 0), dec: declination(L, 0) };
}

export type SkyPosition = {
  azimuth: number; // radians, from south, positive westward
  altitude: number; // radians above the horizon
};

export function sunPosition(date: Date, lat: number, lon: number): SkyPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return {
    azimuth: azimuthFromSouth(H, phi, c.dec),
    altitude: altitudeAbove(H, phi, c.dec),
  };
}

function moonCoords(d: number): { ra: number; dec: number; dist: number } {
  const L = RAD * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = RAD * (134.963 + 13.064993 * d); // mean anomaly
  const F = RAD * (93.272 + 13.22935 * d); // mean distance

  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  const dist = 385001 - 20905 * Math.cos(M); // km

  return { ra: rightAscension(l, b), dec: declination(l, b), dist };
}

// Atmospheric refraction lift for a body near the horizon.
function astroRefraction(h: number): number {
  const hh = Math.max(h, 0);
  return 0.0002967 / Math.tan(hh + 0.00312536 / (hh + 0.08901179));
}

export function moonPosition(
  date: Date,
  lat: number,
  lon: number,
): SkyPosition & { distanceKm: number } {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  const h = altitudeAbove(H, phi, c.dec);
  return {
    azimuth: azimuthFromSouth(H, phi, c.dec),
    altitude: h + astroRefraction(h),
    distanceKm: c.dist,
  };
}

export type MoonIllumination = {
  fraction: number; // 0..1 illuminated fraction of the disc
  phase: number; // 0 new -> 0.5 full -> 1 new
  angle: number; // bright limb angle, radians
};

export function moonIllumination(date: Date): MoonIllumination {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sunDistKm = 149598000;

  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) +
      Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra),
  );
  const inc = Math.atan2(sunDistKm * Math.sin(phi), m.dist - sunDistKm * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) -
      Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );

  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
    angle,
  };
}

/**
 * Az/alt of a fixed celestial position (right ascension/declination, radians)
 * as seen from lat/lon at `date` — e.g. to orient the Milky Way.
 */
export function celestialPosition(
  date: Date,
  lat: number,
  lon: number,
  ra: number,
  dec: number,
): SkyPosition {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const H = siderealTime(toDays(date), lw) - ra;
  return {
    azimuth: azimuthFromSouth(H, phi, dec),
    altitude: altitudeAbove(H, phi, dec),
  };
}

// Map an az/alt sky position to the scene's world frame.
// Scene convention (see windVectorFromDirection): +X east, +Z north, +Y up.
export function sceneDirection(azimuth: number, altitude: number): [number, number, number] {
  const compass = azimuth + Math.PI; // from-south -> compass bearing (0 = north)
  const cosAlt = Math.cos(altitude);
  return [Math.sin(compass) * cosAlt, Math.sin(altitude), Math.cos(compass) * cosAlt];
}

// ---- Wall-clock time in an IANA timezone -> UTC instant --------------------
// The weather payload and the manual settings both describe local wall time in
// the tracked location's zone; astronomy needs the corresponding UTC instant.

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

function tzOffsetMs(epochMs: number, tz: string): number {
  const parts = tzFormatter(tz).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - epochMs;
}

export type ZonedParts = {
  year: number;
  month: number; // 0-based, matching Date
  day: number;
  hour: number;
  minute: number;
};

/** Current wall-clock parts in an IANA timezone. */
export function nowInZone(tz: string, now: Date = new Date()): ZonedParts {
  const parts = tzFormatter(tz).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * UTC instant for a wall-clock time (fractional hours allowed) in a timezone.
 * Two-pass offset lookup handles DST transitions.
 */
export function zonedDate(
  year: number,
  month0: number,
  day: number,
  hourFloat: number,
  tz: string,
): Date {
  const hour = Math.floor(hourFloat);
  const minute = Math.round((hourFloat - hour) * 60);
  const asUtc = Date.UTC(year, month0, day, hour, minute);
  const offset1 = tzOffsetMs(asUtc, tz);
  const offset2 = tzOffsetMs(asUtc - offset1, tz);
  return new Date(asUtc - offset2);
}
