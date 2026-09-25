// Single source of truth for the tracked real-world location. Everything that
// needs coordinates, timezone or a display name (weather API, astronomy,
// clock HUD) reads from here.

export const GOSSENSASS = {
  lat: 46.93857,
  lon: 11.44245,
  tz: "Europe/Rome",
  place: "Gossensass / Colle Isarco, Gemeinde Brenner",
};
