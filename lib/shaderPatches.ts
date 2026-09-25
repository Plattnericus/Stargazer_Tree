import * as THREE from "three";

// three.js evaluates the full lighting BRDF for every point light on every
// pixel, even when the pixel is beyond the light's cutoff distance or the
// light is at intensity 0. getPointLightInfo() already flags those cases
// (directLight.visible is false exactly when the light's color there is
// zero), and a zero-colored light contributes nothing, so guarding the BRDF
// call yields identical pixels. With a dozen short-range lanterns at night
// this skips almost all point-light shading.
//
// Must run before the first shader compiles; import it from the scene module.
// If a three.js upgrade changes the chunk, the patch simply doesn't apply.

const POINT_BLOCK_START = "#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )";
const RE_DIRECT_CALL =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

function patchPointLightLoop(chunk: string): string {
  const start = chunk.indexOf(POINT_BLOCK_START);
  if (start < 0) return chunk;
  const end = chunk.indexOf("#pragma unroll_loop_end", start);
  const call = chunk.indexOf(RE_DIRECT_CALL, start);
  if (end < 0 || call < 0 || call > end) return chunk;
  return chunk.slice(0, call) + "if ( directLight.visible ) " + chunk.slice(call);
}

THREE.ShaderChunk.lights_fragment_begin = patchPointLightLoop(
  THREE.ShaderChunk.lights_fragment_begin,
);
