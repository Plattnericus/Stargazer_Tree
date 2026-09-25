import * as THREE from "three";
// Directional sky-matched fog (patches the fog chunks, see lib/fog.ts).
import "./fog";

// three.js evaluates every point light on every pixel. With a dozen or more
// short-range lanterns at night (3.6-4.5 units) almost every pixel is out of
// range of almost every light, yet each one still paid for the light vector,
// normalize, pow() attenuation and (before the first guard below) the full
// BRDF. Two guards, both pixel-identical:
//   1. a squared-distance range test BEFORE getPointLightInfo(): beyond the
//      cutoff distance the attenuation is exactly zero, so skipping is exact;
//   2. RE_Direct only when directLight.visible (its color is non-zero).
// Out-of-range pixels now cost one dot product per light.
//
// Must run before the first shader compiles; import it from the scene module.
// If a three.js upgrade changes the chunk, the patch simply doesn't apply.

const POINT_BLOCK_START = "#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )";
const GET_INFO_CALL = "getPointLightInfo( pointLight, geometryPosition, directLight );";
const RE_DIRECT_CALL =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

function patchPointLightLoop(chunk: string): string {
  const start = chunk.indexOf(POINT_BLOCK_START);
  if (start < 0) return chunk;
  const end = chunk.indexOf("#pragma unroll_loop_end", start);
  const info = chunk.indexOf(GET_INFO_CALL, start);
  const call = chunk.indexOf(RE_DIRECT_CALL, start);
  if (end < 0 || info < 0 || call < 0 || info > call || call > end) return chunk;
  const callEnd = call + RE_DIRECT_CALL.length;
  // The loop is unrolled by pasting its body once per light into one scope,
  // so the body's local lives in its own braces.
  return (
    chunk.slice(0, info) +
    "{ vec3 plOffset = pointLight.position - geometryPosition;\n" +
    "if ( pointLight.distance <= 0.0 || dot( plOffset, plOffset ) < pointLight.distance * pointLight.distance ) {\n" +
    chunk.slice(info, call) +
    "if ( directLight.visible ) " +
    chunk.slice(call, callEnd) +
    "\n} }" +
    chunk.slice(callEnd)
  );
}

THREE.ShaderChunk.lights_fragment_begin = patchPointLightLoop(
  THREE.ShaderChunk.lights_fragment_begin,
);
