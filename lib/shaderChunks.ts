// Shared GLSL chunks used across the vegetation/terrain materials so the same
// effect never drifts between copies (Tree leaves, Grass, GrassClumps, Island).

// Drifting cloud-shadow term. Requirements in the host shader:
//   uniforms: uTime (float), uWindDir (vec2), uCloudCover (float 0..1)
//   varying:  vWPos (vec3 world position, written by the vertex stage)
// Cheap 2-band interference pattern over world XZ that drifts with the wind —
// reads as cumulus shadows sliding over the island. Multiply into the albedo
// BEFORE lighting so shaded spots still catch rim/sky light.
// Skipped entirely under a clear sky, where it would multiply by exactly 1.
export const CLOUD_SHADOW_FRAG = `
if (uCloudCover > 0.0) {
  vec2 cuv = vWPos.xz * 0.055 + normalize(uWindDir) * uTime * 0.02;
  float cl = sin(cuv.x * 2.1) * sin(cuv.y * 1.7)
           + 0.5 * sin(cuv.x * 4.3 + 1.7) * sin(cuv.y * 3.9 + 0.4);
  float cloudShadow = 1.0 - uCloudCover * 0.45 * smoothstep(-0.2, 0.9, cl);
  diffuseColor.rgb *= cloudShadow;
}
`;

// Aerial perspective: distant ground/foliage tints toward the sky's horizon
// color, the classic depth cue (RDR2/BSL-style haze). Requirements in the host
// shader: uniforms uAerial (float 0..1, tier-gated strength), uHazeColor (vec3,
// the sampled horizon/fog color); varying vWPos. `cameraPosition` is a THREE
// built-in — no need to declare it. A plain MIX (never additive here), so the
// result always stays a valid blend between two already-valid colors — it can
// only ever move the shading toward the sky tint, never break it. uAerial is 0
// on low/medium, where the branch skips the whole term.
export const AERIAL_FRAG = `
if (uAerial > 0.0) {
  float aeD = length(vWPos - cameraPosition);
  // Capped at 0.35 so zoomed-out orbit distances get a subtle depth cue
  // instead of washing the tree out toward the light haze color.
  float aeHaze = (1.0 - exp(-aeD * 0.007)) * uAerial * 0.35;
  diffuseColor.rgb = mix(diffuseColor.rgb, uHazeColor, aeHaze);
}
`;
