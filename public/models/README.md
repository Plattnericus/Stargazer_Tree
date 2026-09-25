# 3D models

Runtime `.glb` files. Components load them by path with `useGLTF` (see the
`MODEL_ASSETS` list in `components/Experience.tsx` and the `useGLTF` calls in
the components). Which building in the village pack belongs to which house
tier is set by `TIER_BUILDING` in `lib/rarity.ts`.

## Keep them small

Every visitor downloads these, so compress them with
[gltf-transform](https://gltf-transform.dev) (already a dev dependency) before
committing. What the current files use:

| File | Treatment |
| --- | --- |
| `ant.glb`, `bird_orange.glb` | `resample` (animation), textures 512px WebP, `meshopt` |
| `grass.glb` | `weld`, `meshopt` |
| `island.glb` | from the uncompressed original (in git history): normals dropped, `weld`, `simplify` to ~20%, smooth normals rebuilt, `meshopt` |
| `stylized_lantern.glb` | textures 512px WebP, geometry left as float |
| `casual_village_buildings_pack.glb` | textures 1024px WebP, geometry left as float |

Two rules the code depends on:

- **Lantern and building geometry must stay float (no `meshopt`/`quantize`).**
  Walk mode cooks their raw vertex arrays into physics colliders, and
  quantized integers there would make the colliders thousands of times too big.
- Code that bakes transforms into a model's geometry has to expand quantized
  attributes to floats first (see `toFloatAttributes` in
  `components/GrassClumps.tsx`).

`useGLTF` decodes Meshopt out of the box. Draco would need an extra decoder
download, so prefer Meshopt.

## Licenses

Every model here needs a row in `CREDITS.md` (the site's Credits panel is built
from it). Sketchfab downloads carry author, license and source in
`asset.extras`; gltf-transform keeps that block, so leave it in when
re-optimizing. `bird_orange.glb` is CC-BY-NC-SA-4.0: non-commercial use only,
and changed versions stay under that license.
