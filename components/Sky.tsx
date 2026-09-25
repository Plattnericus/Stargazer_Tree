"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { SceneParams } from "@/lib/weather";
import { AIRGLOW_GLSL, ATMOSPHERE_GLSL } from "@/lib/atmosphere";
import { SUN_DISC_RADIUS, WEATHER_GLSL } from "@/lib/skyColor";
import { useQualityProfile } from "@/lib/quality";

/**
 * Physically based sky (lib/atmosphere.ts): Rayleigh + Mie + ozone single
 * scattering through a spherical atmosphere, lit by the real sun AND moon.
 * The integral is evaluated into a small sky-view LUT only when the sun, moon
 * or weather change; the dome then costs one texture fetch per pixel, plus
 * the sun disc, cirrus and (at night) the Milky Way on top. lib/skyColor.ts
 * samples the same model on the CPU for fog and light colors, so the whole
 * scene reads from ONE atmosphere.
 */

// ---------------------------------------------------------------------------
// Sky-view LUT: u = world azimuth (atan(x, z) / 2π, wraps), v = sqrt of the
// elevation (0 = horizon, 1 = zenith), which spends most texels on the
// horizon band where the colors change fastest.

const LUT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const LUT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uRayleigh;
  uniform float uHaze;
  uniform float uMieG;
  uniform float uExposure;
  uniform float uMoonExposure;
  uniform vec3 uAmbient;
  uniform float uOvercast;
  uniform float uMood;
  uniform vec3 uMoodColor;
  uniform float uNightGlow;
  uniform vec2 uLutSize;
  varying vec2 vUv;
  ${ATMOSPHERE_GLSL}
  ${AIRGLOW_GLSL}
  ${WEATHER_GLSL}
  void main() {
    float az = vUv.x * 6.28318530718;
    float s = clamp((vUv.y * uLutSize.y - 0.5) / (uLutSize.y - 1.0), 0.0, 1.0);
    float el = s * s * 1.57079632679;
    vec3 d = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
    vec3 col = atmoSky(d, uSunDir, uMoonDir);
    gl_FragColor = vec4(max(applyWeather(col, d.y), vec3(0.0)), 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Dome.

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Just inside the far plane. Exactly z == w rounds past it on some GPUs
    // (ANGLE/Metal) and punches holes into the dome.
    gl_Position.z = gl_Position.w * 0.99999;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform sampler2D uLut;
  uniform vec2 uLutSize;
  uniform vec3 uSunDir;
  uniform vec3 uSunDisc; // HDR disc radiance, transmittance-colored
  uniform float uCirrus; // high ice-cloud coverage 0..1
  uniform vec3 uCirrusLight; // direct sun/moon light on the cirrus deck
  uniform vec3 uCirrusAmbient; // sky light on the cirrus deck
  uniform float uTime;
  uniform vec2 uWind; // cirrus drift (direction * speed)
  uniform vec3 uGalPole; // north galactic pole, scene space
  uniform vec3 uGalCenter; // galactic center, scene space
  uniform float uGalaxy; // Milky Way visibility 0..1
  uniform float uStars; // faint star field visibility 0..1

  const float SUN_R = ${SUN_DISC_RADIUS.toFixed(5)};

  vec3 skyLut(vec3 d) {
    float s = sqrt(asin(clamp(d.y, 0.0, 1.0)) / 1.57079632679);
    vec2 uv = vec2(
      atan(d.x, d.z) / 6.28318530718,
      (s * (uLutSize.y - 1.0) + 0.5) / uLutSize.y
    );
    return texture2D(uLut, uv).rgb;
  }

  // Sin-free hash (Dave Hoskins): stable on mobile GPUs, where sin() of large
  // arguments loses precision and turns noise into visible grids.
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
  }

  float fbm4(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += vnoise(p) * a;
      p = p * 2.13 + vec2(31.7, 11.3);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = skyLut(d);
    // Below the horizon the island floats over more haze: the horizon color
    // carries on, deepening slowly toward the nadir.
    col *= mix(1.0, 0.55, smoothstep(0.0, -0.6, d.y));
    float above = smoothstep(-0.003, 0.003, d.y);

    // ---- sun: limb-darkened disc + tight corona (feeds the bloom) ----
    float mu = dot(d, uSunDir);
    if (mu > 0.9) {
      float r = acos(min(mu, 1.0)) / SUN_R;
      float disc = 1.0 - smoothstep(0.9, 1.0, r);
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - min(r * r, 1.0))));
      float corona = exp(-(1.0 - mu) * 900.0) * 0.03 + exp(-(1.0 - mu) * 90.0) * 0.004;
      col += uSunDisc * (disc * limb + corona) * above;
    }

    // ---- night sky: Milky Way + thousands of faint stars ----
    if (uStars > 0.003 && d.y > -0.02) {
      // Starlight crosses more air near the horizon: dimmer and warmer.
      float extinction = smoothstep(-0.02, 0.35, d.y);
      float band = 0.0;
      if (uGalaxy > 0.003) {
        // Real galactic plane for this date/time and place.
        float b = dot(d, uGalPole); // sin(galactic latitude)
        vec3 e2 = cross(uGalPole, uGalCenter);
        float l = atan(dot(d, e2), dot(d, uGalCenter)); // galactic longitude
        band = exp(-b * b / 0.018);
        float bulge = exp(-l * l / 0.5) * exp(-b * b / 0.06);
        // Clumpy star clouds: isotropic noise in galactic angles (b ≈
        // latitude in radians near the plane).
        vec2 gp = vec2(l, b) * 9.0;
        float n = vnoise(gp) * 0.5 + vnoise(gp * 2.3 + 7.1) * 0.3 + vnoise(gp * 5.1 + 3.3) * 0.2;
        n = n * n * 1.6;
        // The Great Rift: dust lanes darkening the middle of the band.
        float dust = smoothstep(0.45, 0.75, vnoise(vec2(l * 7.0, b * 26.0) + 11.0)) * exp(-b * b / 0.006);
        float mw = band * (0.25 + n) * (1.0 + 2.4 * bulge) * (1.0 - 0.8 * dust);
        col += vec3(0.75, 0.82, 1.0) * mw * uGalaxy * 0.036 * extinction;
        band *= uGalaxy;
      }
      // One candidate star per cell of a 3D grid the view ray passes
      // through; the Milky Way band holds about three times as many.
      vec3 sp = d * 260.0;
      vec3 cell = floor(sp);
      float h = hash13(cell);
      if (h > 0.972 - band * 0.05) {
        vec3 off = hash33(cell) * 0.7 + 0.15;
        float r = length(sp - cell - off);
        float mag = hash13(cell + 17.3);
        float twinkle = 0.75 + 0.25 * sin(uTime * (1.5 + mag * 3.0) + h * 80.0);
        float star = smoothstep(0.22, 0.0, r) * (0.5 + 2.5 * mag * mag * mag) * twinkle;
        vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.75, 0.85, 1.0), hash13(cell + 5.1));
        col += tint * star * 0.16 * uStars * extinction;
      }
    }

    // ---- high cirrus: wind-combed ice streaks lit by the real sun/moon ----
    if (uCirrus > 0.015 && d.y > 0.02) {
      vec2 sp = d.xz / (d.y + 0.12); // project onto a high deck
      vec2 windDir = normalize(uWind + vec2(1e-4));
      // rotate so the streaks comb ALONG the wind
      vec2 rp = vec2(sp.x * windDir.x + sp.y * windDir.y, -sp.x * windDir.y + sp.y * windDir.x);
      rp += vec2(length(uWind) * uTime, 0.0);
      float streaks = fbm4(vec2(rp.x * 0.35, rp.y * 1.7));
      float body = fbm4(rp * 0.3 + streaks * 0.7);
      float pattern = body * 0.75 + streaks * 0.65;
      float edge0 = 1.0 - uCirrus * 1.15;
      float cover = smoothstep(edge0, edge0 + 0.3, pattern);
      float horizonFade = smoothstep(0.02, 0.2, d.y);
      // Ice crystals scatter strongly forward: bright near the sun/moon.
      float g = 0.55;
      float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
      vec3 cirrusCol = uCirrusAmbient + uCirrusLight * (0.18 + 0.1 * hg);
      col = mix(col, cirrusCol, cover * horizonFade * 0.7);
    }

    // Dither against banding in the smooth twilight ramps. Its size follows
    // the local sRGB step (~ value^0.55), and it never pushes a channel
    // negative: post turns negatives into NaN, which read as white static.
    float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col = max(col, vec3(0.0));
    col = max(col + (dn - 0.5) * (2.2 / 255.0) * pow(col + 0.0005, vec3(0.55)), vec3(0.0));

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Uniforms that feed the LUT, in the order they're packed for change checks.
const LUT_KEYS = [
  "uRayleigh",
  "uHaze",
  "uMieG",
  "uExposure",
  "uMoonExposure",
  "uOvercast",
  "uMood",
  "uNightGlow",
] as const;

export function Sky({ params }: { params: SceneParams }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const [lutW, lutH] = useQualityProfile().skyLutSize;

  const lut = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(lutW, lutH, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return target;
  }, [lutW, lutH]);
  useEffect(() => () => lut.dispose(), [lut]);

  const lutPass = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uRayleigh: { value: 1 },
        uHaze: { value: 1 },
        uMieG: { value: 0.8 },
        uExposure: { value: 20 },
        uMoonExposure: { value: 0 },
        uAmbient: { value: new THREE.Vector3() },
        uOvercast: { value: 0 },
        uMood: { value: 0 },
        uMoodColor: { value: new THREE.Color(0.35, 0.42, 0.48) },
        uNightGlow: { value: 1 },
        uLutSize: { value: new THREE.Vector2(lutW, lutH) },
      },
      vertexShader: LUT_VERTEX,
      fragmentShader: LUT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    return { material, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), quad };
  }, [lutW, lutH]);
  useEffect(
    () => () => {
      lutPass.material.dispose();
      lutPass.quad.geometry.dispose();
    },
    [lutPass],
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        // Drawn first (renderOrder -1) and never occluding anything, so there
        // is nothing to depth-test against.
        depthTest: false,
        fog: false,
        uniforms: {
          uLut: { value: lut.texture },
          uLutSize: { value: new THREE.Vector2(lutW, lutH) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunDisc: { value: new THREE.Vector3() },
          uCirrus: { value: 0 },
          uCirrusLight: { value: new THREE.Vector3() },
          uCirrusAmbient: { value: new THREE.Vector3() },
          uTime: { value: 0 },
          uWind: { value: new THREE.Vector2(0.01, 0) },
          uGalPole: { value: new THREE.Vector3(0, 1, 0) },
          uGalCenter: { value: new THREE.Vector3(1, 0, 0) },
          uGalaxy: { value: 0 },
          uStars: { value: 0 },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
      }),
    [lut, lutW, lutH],
  );
  useEffect(() => () => material.dispose(), [material]);

  // Smoothed state, eased toward params so weather/time changes fade.
  const cur = useRef<{
    sun: THREE.Vector3;
    moon: THREE.Vector3;
    logExposure: number;
    ambient: THREE.Vector3;
    sunDisc: THREE.Vector3;
    cirrusLight: THREE.Vector3;
    cirrusAmbient: THREE.Vector3;
    first: boolean;
  } | null>(null);
  const last = useRef(new Float32Array(LUT_KEYS.length + 9).fill(NaN));
  const frames = useRef(0);
  const target = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const mesh = meshRef.current;
    if (mesh) mesh.position.copy(camera.position); // dome rides with the camera

    const a = params.atmosphere;
    if (!cur.current) {
      cur.current = {
        sun: new THREE.Vector3(...params.sunPos).normalize(),
        moon: new THREE.Vector3(...params.moon.pos).normalize(),
        logExposure: Math.log(a.exposure),
        ambient: new THREE.Vector3(...a.ambient),
        sunDisc: new THREE.Vector3(...params.sunDisc),
        cirrusLight: new THREE.Vector3(...params.cirrus.light),
        cirrusAmbient: new THREE.Vector3(...params.cirrus.ambient),
        first: true,
      };
    }
    const c = cur.current;
    const first = c.first;
    c.first = false;
    const k = first ? 1 : Math.min(1, dt * 1.5);
    const kDir = first ? 1 : Math.min(1, dt * 2);

    c.sun.lerp(target.set(...params.sunPos).normalize(), kDir).normalize();
    c.moon.lerp(target.set(...params.moon.pos).normalize(), kDir).normalize();
    c.logExposure += (Math.log(a.exposure) - c.logExposure) * kDir;
    c.ambient.lerp(target.set(...a.ambient), kDir);
    c.sunDisc.lerp(target.set(...params.sunDisc), kDir);
    c.cirrusLight.lerp(target.set(...params.cirrus.light), k);
    c.cirrusAmbient.lerp(target.set(...params.cirrus.ambient), k);

    // ---- LUT inputs ----
    const lu = lutPass.material.uniforms;
    (lu.uSunDir.value as THREE.Vector3).copy(c.sun);
    (lu.uMoonDir.value as THREE.Vector3).copy(c.moon);
    const ease = (key: string, to: number) => {
      lu[key].value += (to - lu[key].value) * k;
    };
    ease("uRayleigh", a.rayleigh);
    ease("uHaze", a.haze);
    lu.uMieG.value = a.mieG;
    lu.uExposure.value = Math.exp(c.logExposure);
    ease("uMoonExposure", a.moonExposure);
    ease("uOvercast", a.overcast);
    ease("uMood", a.moodMix);
    ease("uNightGlow", a.nightGlow);
    (lu.uAmbient.value as THREE.Vector3).copy(c.ambient);
    (lu.uMoodColor.value as THREE.Color).setRGB(a.moodColor[0], a.moodColor[1], a.moodColor[2]);
    // Snap a moon that is fading out to exactly zero so the LUT pass drops
    // the moon integral again.
    if (lu.uMoonExposure.value < 1e-3 && a.moonExposure === 0) lu.uMoonExposure.value = 0;

    // Re-render the LUT only when an input actually moved.
    const sig = last.current;
    let changed = false;
    const check = (i: number, v: number, eps: number) => {
      if (!(Math.abs(sig[i] - v) <= eps * Math.max(1, Math.abs(v)))) {
        sig[i] = v;
        changed = true;
      }
    };
    LUT_KEYS.forEach((key, i) => check(i, lu[key].value as number, 2e-4));
    const n = LUT_KEYS.length;
    check(n, c.sun.x, 2e-5);
    check(n + 1, c.sun.y, 2e-5);
    check(n + 2, c.sun.z, 2e-5);
    check(n + 3, c.moon.x, 2e-4);
    check(n + 4, c.moon.y, 2e-4);
    check(n + 5, c.moon.z, 2e-4);
    check(n + 6, c.ambient.x, 1e-3);
    check(n + 7, c.ambient.y, 1e-3);
    check(n + 8, c.ambient.z, 1e-3);
    // Also redraw for the first frames (the program may still be compiling
    // in parallel, which skips the draw) and every few seconds after, which
    // is nearly free and heals a lost/restored context.
    frames.current++;
    if (changed || frames.current < 90 || frames.current % 240 === 0) {
      const prev = state.gl.getRenderTarget();
      gl.setRenderTarget(lut);
      gl.render(lutPass.scene, lutPass.camera);
      gl.setRenderTarget(prev);
    }

    // ---- dome inputs ----
    const u = material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(c.sun);
    (u.uSunDisc.value as THREE.Vector3).copy(c.sunDisc);
    u.uCirrus.value +=
      (params.clouds.high.coverage * (1 - a.overcast) * (1 - a.moodMix) - (u.uCirrus.value as number)) * k;
    (u.uCirrusLight.value as THREE.Vector3).copy(c.cirrusLight);
    (u.uCirrusAmbient.value as THREE.Vector3).copy(c.cirrusAmbient);
    u.uTime.value = state.clock.elapsedTime;
    const drift = 0.004 + Math.min(0.03, params.windKmh * 0.0006);
    (u.uWind.value as THREE.Vector2).set(params.windVec[0], params.windVec[1]).multiplyScalar(drift);
    (u.uGalPole.value as THREE.Vector3).set(...params.galaxy.pole);
    (u.uGalCenter.value as THREE.Vector3).set(...params.galaxy.center);
    u.uGalaxy.value += (params.galaxy.visible - (u.uGalaxy.value as number)) * k;
    // Faint stars drown in moonlight long before the bright ones do.
    const moonUp = Math.min(1, Math.max(0, params.moon.pos[1] / 20));
    const faint = params.starsIntensity * (1 - moonUp * params.moon.illumination * 0.6);
    u.uStars.value += (faint - (u.uStars.value as number)) * k;
  }, -2);

  return (
    <mesh ref={meshRef} material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[100, 48, 24]} />
    </mesh>
  );
}
