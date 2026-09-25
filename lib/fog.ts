import * as THREE from "three";

// Directional, sky-matched distance fog for every built-in material.
//
// three.js fogs everything toward ONE color, but a real horizon isn't one
// color: toward a low sun the haze glows amber, away from it it's a cool blue
// (and at dusk the Earth's shadow). Distant geometry should fade into the sky
// that is actually behind it, or the island reads as pasted onto the dome.
//
// The fog chunks are patched to blend the fog color by view azimuth between
// three horizon samples of the same atmosphere the dome renders (see
// lib/weather.ts: fogSunColor / fogColor / fogAntiColor). The extra uniforms
// are added to every ShaderLib entry that has fog. Their values are shared
// Float32Arrays: three's cloneUniforms() copies typed arrays by reference, so
// every material program reads the same three arrays, updated once per frame
// by SceneRig. Custom ShaderMaterials with fog never receive them (they read
// as zero), which disables the directional part and leaves plain fog.

export const fogSunDir = new Float32Array(3); // flat unit vector toward the sun (x, 0, z)
export const fogSunColor = new Float32Array(3); // linear horizon color toward the sun
export const fogAntiColor = new Float32Array(3); // linear horizon color away from it

const FOG_UNIFORMS = {
  fogSunDir: { value: fogSunDir },
  fogSunColor: { value: fogSunColor },
  fogAntiColor: { value: fogAntiColor },
};

for (const shader of Object.values(THREE.ShaderLib)) {
  if (shader.uniforms && "fogColor" in shader.uniforms) Object.assign(shader.uniforms, FOG_UNIFORMS);
}

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogOffset;
#endif
`;

// World-space offset camera -> vertex: the view-space position rotated back
// by the view matrix (mat3 * vector from the left = transpose = inverse).
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogOffset = mvPosition.xyz * mat3( viewMatrix );
#endif
`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  uniform vec3 fogAntiColor;
  varying float vFogDepth;
  varying vec3 vFogOffset;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

// fogColor is the horizon 90° from the sun; toward the sun it blends into the
// (narrow, Mie-shaped) glow, away from it into the anti-sun sky.
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 fogTint = fogColor;
  if ( fogFactor > 0.0 && dot( fogSunDir, fogSunDir ) > 0.5 ) {
    vec2 fogFlat = vFogOffset.xz / max( length( vFogOffset.xz ), 1e-4 );
    float fogCos = dot( fogFlat, fogSunDir.xz );
    float toSun = max( fogCos, 0.0 );
    toSun *= toSun;
    float away = max( - fogCos, 0.0 );
    fogTint += ( fogSunColor - fogColor ) * ( toSun * toSun ) + ( fogAntiColor - fogColor ) * ( away * sqrt( away ) );
  }
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif
`;
