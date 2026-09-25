"use client";

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneParams } from "@/lib/weather";
import { SUN_ANGULAR_DIAMETER_COS, type Atmosphere } from "@/lib/skyColor";

/**
 * Physically-based sky dome: Preetham-style single scattering (Rayleigh + Mie)
 * evaluated per pixel from the REAL sun direction — deep zenith blue, warm
 * horizon, physically colored dawn/dusk, a real-scale sun disc, and a moonlit
 * Rayleigh glow at night. Weather flattens it toward an overcast deck or a
 * storm slate exactly like lib/skyColor.ts does for fog/lights, so the whole
 * scene reads from ONE atmosphere. One analytic evaluation per fragment, no
 * raymarch.
 */

const SKY_VERTEX = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uTurbidity;
  uniform float uRayleigh;
  uniform float uMieCoefficient;

  varying vec3 vDir;
  varying vec3 vSunDirection;
  varying float vSunE;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;

  const vec3 up = vec3(0.0, 1.0, 0.0);
  const float e = 2.71828182845904523536028747135266249775724709369995957;
  const float pi = 3.141592653589793238462643383279502884197169;

  const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
  const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);

  const float cutoffAngle = 1.6110731556870734; // pi / 1.95
  const float steepness = 1.5;
  const float EE = 1000.0;

  float sunIntensity(float zenithAngleCos) {
    zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
    return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
  }

  vec3 totalMie(float T) {
    float c = (0.2 * T) * 10E-18;
    return 0.434 * c * MieConst;
  }

  void main() {
    vDir = normalize(position);
    vSunDirection = normalize(uSunDir);
    vSunE = sunIntensity(dot(vSunDirection, up));
    vSunfade = 1.0 - clamp(1.0 - exp((vSunDirection.y * 400000.0) / 450000.0), 0.0, 1.0);
    float rayleighCoefficient = uRayleigh - (1.0 * (1.0 - vSunfade));
    vBetaR = totalRayleigh * rayleighCoefficient;
    vBetaM = totalMie(uTurbidity) * uMieCoefficient;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.z = gl_Position.w; // pin to the far plane
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  varying vec3 vSunDirection;
  varying float vSunE;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;

  uniform float uMieDirectionalG;
  uniform float uExposure;
  uniform float uOvercast;
  uniform float uMood;
  uniform vec3 uMoodColor;
  uniform vec3 uMoonDir;
  uniform float uMoonE;
  uniform float uSunDiskCos;
  uniform float uCirrus; // high ice-cloud coverage 0..1
  uniform vec3 uSunTint; // direct-sun transmittance color (linear)
  uniform float uTwilight; // 0..1 while the sun crosses the horizon
  uniform float uTime;
  uniform vec2 uWind; // cirrus drift (direction * speed)

  const vec3 up = vec3(0.0, 1.0, 0.0);
  const float pi = 3.141592653589793238462643383279502884197169;

  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;

  float chash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(chash(i), chash(i + vec2(1.0, 0.0)), f.x),
               mix(chash(i + vec2(0.0, 1.0)), chash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float cfbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += cnoise(p) * a;
      p = p * 2.13 + vec2(31.7, 11.3);
      a *= 0.5;
    }
    return v;
  }

  float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * pi)) * (1.0 + pow(cosTheta, 2.0));
  }

  float hgPhase(float cosTheta, float g) {
    float g2 = pow(g, 2.0);
    float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
    return (1.0 / (4.0 * pi)) * ((1.0 - g2) * inverse);
  }

  void main() {
    vec3 direction = normalize(vDir);

    // optical length (zenith-normalized air mass)
    float zenithAngle = acos(max(0.0, dot(up, direction)));
    float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;

    // combined extinction
    vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

    // in-scattering
    float cosTheta = dot(direction, vSunDirection);
    float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
    vec3 betaRTheta = vBetaR * rPhase;
    float mPhase = hgPhase(cosTheta, uMieDirectionalG);
    vec3 betaMTheta = vBetaM * mPhase;

    vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
    Lin *= mix(
      vec3(1.0),
      pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)),
      clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0)
    );

    // base night sky + real-scale sun disc with soft limb
    vec3 L0 = vec3(0.1) * Fex;
    float sundisk = smoothstep(uSunDiskCos, uSunDiskCos + 0.00004, cosTheta);
    L0 += (vSunE * 19000.0 * Fex) * sundisk;

    vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    // Exposure AFTER the Preetham gamma: keeps deep zenith blue instead of
    // pushing everything into ACES' white shoulder.
    vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade)))) * uExposure;

    // ---- weather (matches lib/skyColor.ts) ----
    float lum = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
    // filmic vibrance so clear skies stay rich after tone mapping
    retColor = max(mix(vec3(lum), retColor, 1.5), vec3(0.0));
    vec3 overcastCol = vec3(lum * 0.92, lum * 0.96, lum);
    retColor = mix(retColor, overcastCol, uOvercast);
    retColor = mix(retColor, uMoodColor * (0.35 + lum), uMood);

    // ---- moonlit night: Rayleigh in-scatter from the real moon ----
    if (uMoonE > 0.0001) {
      float cosMoon = dot(direction, normalize(uMoonDir));
      float mrPhase = rayleighPhase(cosMoon * 0.5 + 0.5);
      vec3 moonScatter = uMoonE * ((vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5) * mrPhase) / (vBetaR + vBetaM)) * (1.0 - Fex);
      retColor += moonScatter * vec3(0.5, 0.62, 0.9);
      // soft aureole hugging the moon disc
      retColor += vec3(0.5, 0.6, 0.85) * uMoonE * 0.004 * pow(max(cosMoon, 0.0), 180.0);
    }

    // ---- Belt of Venus: the pink anti-solar arch of real twilight ----
    if (uTwilight > 0.01) {
      vec2 dh2 = normalize(vec2(direction.x, direction.z) + 1e-5);
      vec2 sh2 = normalize(vec2(vSunDirection.x, vSunDirection.z) + 1e-5);
      float away = pow(max(dot(dh2, -sh2), 0.0), 2.0);
      float arch = 1.0 - smoothstep(0.02, 0.22, abs(direction.y - 0.07));
      retColor += vec3(0.45, 0.2, 0.28) * away * arch * uTwilight * 0.35 * (1.0 - uOvercast);
    }

    // ---- high cirrus: wind-combed ice streaks lit by the real sun color ----
    float cirrusAmount = uCirrus * (1.0 - uOvercast) * (1.0 - uMood);
    if (cirrusAmount > 0.015 && direction.y > 0.02) {
      vec2 sp = direction.xz / (direction.y + 0.12); // project onto a high deck
      vec2 windDir = normalize(uWind + vec2(1e-4));
      // rotate so the streaks comb ALONG the wind
      vec2 rp = vec2(sp.x * windDir.x + sp.y * windDir.y, -sp.x * windDir.y + sp.y * windDir.x);
      rp += vec2(length(uWind) * uTime, 0.0);
      float streaks = cfbm(vec2(rp.x * 0.35, rp.y * 1.7));
      float body = cfbm(rp * 0.3 + streaks * 0.7);
      float pattern = body * 0.75 + streaks * 0.65;
      float edge0 = 1.0 - cirrusAmount * 1.15;
      float cover = smoothstep(edge0, edge0 + 0.3, pattern);
      float horizonFade = smoothstep(0.02, 0.2, direction.y);
      float toSun = pow(max(cosTheta, 0.0), 3.0);
      float lum2 = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
      vec3 cirrusCol = mix(vec3(0.9, 0.93, 1.0), uSunTint * 1.15,
                           clamp(toSun * 0.85 + uTwilight * 0.5, 0.0, 1.0))
                       * (0.1 + lum2 * 1.5 + toSun * 0.25);
      retColor = mix(retColor, cirrusCol, cover * horizonFade * 0.65);
    }

    // ordered dither kills gradient banding in the smooth twilight ramps
    float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    retColor += (dn - 0.5) * (1.5 / 255.0);

    gl_FragColor = vec4(retColor, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function Sky({ params }: { params: SceneParams }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uTurbidity: { value: 2.5 },
          uRayleigh: { value: 2.6 },
          uMieCoefficient: { value: 0.005 },
          uMieDirectionalG: { value: 0.8 },
          uExposure: { value: 0.45 },
          uOvercast: { value: 0 },
          uMood: { value: 0 },
          uMoodColor: { value: new THREE.Color(0.35, 0.42, 0.48) },
          uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
          uMoonE: { value: 0 },
          uSunDiskCos: { value: SUN_ANGULAR_DIAMETER_COS },
          uCirrus: { value: 0 },
          uSunTint: { value: new THREE.Color("#fff1d4") },
          uTwilight: { value: 0 },
          uTime: { value: 0 },
          uWind: { value: new THREE.Vector2(0.01, 0) },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
      }),
    [],
  );

  const cur = useRef<{ sun: THREE.Vector3; moon: THREE.Vector3; a: Atmosphere }>({
    sun: new THREE.Vector3(0, 1, 0),
    moon: new THREE.Vector3(0, 1, 0),
    a: {
      turbidity: 2.5,
      rayleigh: 2.6,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.8,
      exposure: 0.45,
      overcast: 0,
      moodMix: 0,
      moodColor: [0.35, 0.42, 0.48],
      moonE: 0,
    },
  });
  const target = useMemo(() => new THREE.Vector3(), []);
  const sunTintTarget = useMemo(() => new THREE.Color(), []);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (mesh) mesh.position.copy(camera.position); // dome rides with the camera

    const k = Math.min(1, dt * 1.5);
    const c = cur.current;
    const a = params.atmosphere;

    target.set(params.sunPos[0], params.sunPos[1], params.sunPos[2]).normalize();
    c.sun.lerp(target, Math.min(1, dt * 2)).normalize();
    target.set(params.moon.pos[0], params.moon.pos[1], params.moon.pos[2]).normalize();
    c.moon.lerp(target, Math.min(1, dt * 2)).normalize();

    c.a.turbidity += (a.turbidity - c.a.turbidity) * k;
    c.a.rayleigh += (a.rayleigh - c.a.rayleigh) * k;
    c.a.mieCoefficient += (a.mieCoefficient - c.a.mieCoefficient) * k;
    c.a.overcast += (a.overcast - c.a.overcast) * k;
    c.a.moodMix += (a.moodMix - c.a.moodMix) * k;
    c.a.moonE += (a.moonE - c.a.moonE) * k;

    const u = material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(c.sun);
    (u.uMoonDir.value as THREE.Vector3).copy(c.moon);
    u.uTurbidity.value = c.a.turbidity;
    u.uRayleigh.value = c.a.rayleigh;
    u.uMieCoefficient.value = c.a.mieCoefficient;
    u.uMieDirectionalG.value = a.mieDirectionalG;
    u.uExposure.value = a.exposure;
    u.uOvercast.value = c.a.overcast;
    u.uMood.value = c.a.moodMix;
    (u.uMoodColor.value as THREE.Color).setRGB(a.moodColor[0], a.moodColor[1], a.moodColor[2]);
    u.uMoonE.value = c.a.moonE;

    // Cirrus deck: coverage from the real high-cloud reading, combed and
    // drifted by the real wind, lit by the real sun transmittance color.
    u.uCirrus.value += (params.clouds.high.coverage - (u.uCirrus.value as number)) * k;
    (u.uSunTint.value as THREE.Color).lerp(sunTintTarget.set(params.sunColor), k);
    u.uTwilight.value += (params.twilight - (u.uTwilight.value as number)) * k;
    u.uTime.value = _.clock.elapsedTime;
    const drift = 0.004 + Math.min(0.03, params.windKmh * 0.0006);
    (u.uWind.value as THREE.Vector2)
      .set(params.windVec[0], params.windVec[1])
      .multiplyScalar(drift);
  });

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 24]} />
    </mesh>
  );
}
