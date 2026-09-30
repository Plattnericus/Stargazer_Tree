# GitHub Star Tree

A living 3D portfolio scene where a GitHub repository grows into a small treehouse village. The tracked repo's stars drive the tree, every stargazer becomes a house, and the world reacts to live mountain weather from Gossensaß / Colle Isarco in South Tyrol.

Built as a polished real-time WebGL experience with Next.js, React Three Fiber, shader-driven weather, animated UI, and deterministic GitHub data mapping.

## Overview

GitHub Star Tree turns repository activity into a calm, explorable 3D scene:

- Stars grow the tree and determine how dense the village becomes.
- Stargazers are rendered as houses placed deterministically around the tree.
- House rarity is based on GitHub profile clout plus contributor status.
- The scene mirrors live weather from Gossensaß / Gemeinde Brenner.
- Night mode adds stars and a procedural moon phase.
- Users can orbit, zoom, pan, fly around, search houses, inspect profiles, and override weather for demos.

## Highlights

### Living GitHub Village

- Live stargazer count from a single configured repository.
- Deterministic layout, so houses do not reshuffle on reload.
- Per-stargazer rarity tiers using profile signals and contributor bonus.
- Profile panel with GitHub information and repository context.
- Search and highlight flow for quickly finding a house.

### Real-Time Weather

The environment follows Open-Meteo data for Gossensaß / Colle Isarco:

- Temperature, humidity, pressure, visibility.
- Rain, snow, fog, storm state.
- Wind speed, gusts, and wind direction.
- Low, mid, and high cloud cover.
- Day/night lighting based on local time.
- Seasonal foliage and snow accumulation.

Weather affects lighting, fog, volumetric clouds, grass, leaves, branch sway, precipitation drift, and the overall scene mood.

### Night Sky

- GPU-friendly star field with subtle color variation and twinkle.
- Procedural moon with calculated phase, illumination, halo, and crater detail.
- Stars and moon visibility are suppressed by daylight, cloud cover, fog, and rain.
- No moon texture is required.

### Performance-Focused 3D

The small ivory dove is a hidden memorial, tucked into the rear of the village.
Finding and clicking it opens the church of Boden as a full-screen scroll walk.
GSAP ScrollTrigger drives a camera path along the central aisle, with
quiet typography and a link to the memorial page. Reduced-motion mode
keeps the camera still. The scan, Draco decoder, and fonts are served locally;
the island pauses while the church is open and the church renders on demand.
Asset and font licenses are included with the project.

- React Three Fiber and Drei scene composition.
- Adaptive DPR and cloud quality based on frame budget.
- Shader-driven volumetric clouds.
- Instanced or batched effects where practical.
- Reduced-quality path while camera/fly controls are moving.
- Pointer-lock fly controls for smooth movement.

## Tech Stack

| Area | Technology |
| --- | --- |
| Framework | Next.js App Router |
| Language | TypeScript |
| UI | React, Tailwind CSS |
| 3D | Three.js, React Three Fiber, Drei |
| Animation | GSAP, React frame loops |
| Data | GitHub REST API, Open-Meteo |
| Deployment target | Vercel |

## Project Structure

```text
app/
  page.tsx                    Main client experience shell
  api/
    stargazers/route.ts       GitHub star + stargazer data
    weather/route.ts          Live Open-Meteo weather
    gh-user/route.ts          Profile panel data

components/
  Experience.tsx              Main R3F canvas scene
  Tree.tsx                    Tree, growth, foliage and wind response
  Houses.tsx                  Stargazer houses and interactions
  NightSky.tsx                Stars and procedural moon
  Weather.tsx                 Rain, snow and storm particles
  SettingsMenu.tsx            Live/manual weather and quality controls
  LoadingOverlay.tsx          Animated loading experience

lib/
  weather.ts                  Weather mapping, moon phase and scene params
  rarity.ts                   Rarity scoring
  stargazers.ts               Stargazer types and naming helpers
  growth.ts                   Star count to tree growth mapping
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

Recommended variables:

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_REPO` | No | Repository to visualize. Defaults to `Plattnericus/ThreeJS_Portfolio`. |
| `GITHUB_TOKEN` | No | Server-side GitHub token for higher rate limits. |
| `DEMO_STARS` | No | Fallback star count if GitHub is unavailable. |
| `NEXT_PUBLIC_DEV_CONTROLS` | No | Enables local star +/- controls for development. |

### 3. Run locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

### 4. Build

```bash
npm run build
```

## Data Flow

```text
GitHub API
  -> /api/stargazers
  -> scored stargazer payload
  -> 3D tree, houses, HUD

Open-Meteo
  -> /api/weather
  -> normalized SceneParams
  -> sky, fog, clouds, wind, particles, moon, stars
```

The browser receives render-ready data. Secrets remain server-side.

## Weather Model

The scene uses realistic mapping rather than fixed visual presets:

- Cloud layers drive volumetric coverage and sun dimming.
- Visibility and humidity affect fog density.
- Wind direction is converted from meteorological "from" bearing into scene-space downwind motion.
- Gusts add short turbulence to foliage, clouds and particles.
- Moon phase is computed from the selected/live date using a synodic month cycle.
- Stars and moon fade out under daylight, heavy cloud, fog or rain.

Manual mode uses the same data shape as live mode, so testing a night, storm or snow scene exercises the real rendering path.

## Assets

Runtime models live in:

```text
public/models/
```

Credits and licenses are tracked in:

```text
CREDITS.md
```

When adding or replacing GLB assets, keep files optimized and register them consistently with the existing model pipeline.

## Deployment

The app is designed for Vercel:

- Next.js App Router routes run server-side.
- GitHub star data refreshes on page load and every five minutes while the app is open.
- Open-Meteo weather data is cached by the weather route.
- `GITHUB_TOKEN` should be configured as a Vercel environment variable for higher GitHub API limits.

## Performance Notes

The scene targets a smooth laptop experience:

- Adaptive resolution scaling.
- Lower volumetric cloud cost while moving.
- Quality presets for grass density and cloud detail.
- Single draw-call star field.
- Procedural moon shader instead of texture downloads.
- Controlled particle counts for rain, snow and ambient effects.

## Current Limitations

- The main tree asset is stylized and static; true organic growth requires a morph-target or rigged GLB.
- GitHub contributor enrichment is intentionally capped to protect API rate limits.
- The existing `npm run lint` script uses the legacy `next lint` command and should be migrated if linting is required on Next.js 16.

## License

This repository is a personal portfolio project. Check individual model licenses in `CREDITS.md` before reusing assets.
