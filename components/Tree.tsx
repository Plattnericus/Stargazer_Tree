"use client";

import { use, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeElements } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import gsap from "gsap";
import { animated, useSpring } from "@react-spring/three";
import { bonsaiNodes, makeTaperedTubeGeometry, spineAt } from "@/lib/bonsai";
import { trunkBaseRadius, trunkHeight } from "@/lib/growth";
import { MAX_HOUSES } from "@/lib/layout";
import { useQualityProfile } from "@/lib/quality";
import { deckRadius, type Tier } from "@/lib/rarity";
import { CLOUD_SHADOW_FRAG } from "@/lib/shaderChunks";
import { SPRIG_STRIDE, type CanopyInput } from "@/lib/canopy";
import { requestBarkTextures, useCanopy, type BarkTextures } from "@/lib/treeWorkerClient";

// The grow-in animation plays once per page load. Later remounts of the scene
// (quality switch, the first time walk mode adds physics) show the grown tree
// right away instead of regrowing it.
let growIntroPlayed = false;

// Instanced leaf clumps for one canopy batch.
function LeafClumps({
  sprigs,
  geometry,
  material,
  depthMaterial,
  grown,
  density = 1,
  castShadow = false,
  receiveShadow = false,
}: {
  /** Packed sprigs from lib/canopy.ts (SPRIG_STRIDE numbers each). */
  sprigs: Float64Array;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  depthMaterial?: THREE.Material;
  grown: boolean;
  /** Fraction of the sprigs to draw. They're shuffled, so fewer means evenly thinner. */
  density?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const firstGrowRun = useRef(true);
  const count = sprigs.length / SPRIG_STRIDE;
  // Re-apply matrices after r3f recreates the instanced mesh.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    // Per-instance shade/hue/phase for the leaf shader.
    const aLeaf = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const o = i * SPRIG_STRIDE;
      p.set(sprigs[o], sprigs[o + 1], sprigs[o + 2]);
      e.set(sprigs[o + 3], sprigs[o + 4], sprigs[o + 5]);
      q.setFromEuler(e);
      s.setScalar(sprigs[o + 6]);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      aLeaf[i * 3] = sprigs[o + 7];
      aLeaf[i * 3 + 1] = sprigs[o + 8];
      aLeaf[i * 3 + 2] = sprigs[o + 9];
    }
    geometry.setAttribute("aLeaf", new THREE.InstancedBufferAttribute(aLeaf, 3));
    mesh.instanceMatrix.needsUpdate = true;
    // Correct culling sphere — the base sprig geometry alone is tiny.
    mesh.computeBoundingSphere();
    mesh.visible = grown;
    mesh.scale.setScalar(grown ? 1 : 0.001);
  }, [sprigs, count, geometry, grown]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh) mesh.count = Math.max(1, Math.round(count * Math.min(1, density)));
  }, [count, density]);

  // Animate canopy growth.
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const skipIntro = firstGrowRun.current && growIntroPlayed;
    firstGrowRun.current = false;
    if (skipIntro) return; // the layout effect already set the final state
    gsap.killTweensOf(mesh.scale);
    if (grown) {
      mesh.visible = true;
      gsap.fromTo(
        mesh.scale,
        { x: 0.001, y: 0.001, z: 0.001 },
        { x: 1, y: 1, z: 1, duration: 0.75, delay: 0.28, ease: "back.out(1.7)" },
      );
    } else {
      gsap.to(mesh.scale, {
        x: 0.001,
        y: 0.001,
        z: 0.001,
        duration: 0.3,
        ease: "power2.in",
        onComplete: () => {
          if (ref.current) ref.current.visible = false;
        },
      });
    }
  }, [grown]);

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, count]}
      customDepthMaterial={depthMaterial}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      scale={0.001}
      visible={false}
    />
  );
}

// The procedural bark texture (lib/barkTexture.ts, built in the tree worker)
// carries all the color, so the trunk, branches and roots share one material.
function makeBarkMaterial({ map, bump, rough }: BarkTextures) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    bumpMap: bump,
    bumpScale: 1.7,
    roughnessMap: rough,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
}

// Cut-branch cap material with subtle annual rings.
function makeRingCapMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: "#caa46a",
    roughness: 0.82,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec2 vCap;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n vCap = position.xy;",
      );
    shader.fragmentShader =
      "varying vec2 vCap;\n" +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float rad = length(vCap);
        float ang = atan(vCap.y, vCap.x);
        float wob = sin(ang * 7.0) * 0.004 + sin(ang * 3.0 + 1.2) * 0.006;
        float rings = sin((rad + wob) * 120.0) * 0.5 + 0.5;
        vec3 lightw = vec3(0.80, 0.64, 0.40);
        vec3 darkw = vec3(0.45, 0.31, 0.16);
        vec3 woodc = mix(darkw, lightw, rings);
        woodc *= mix(0.78, 1.0, smoothstep(0.0, 0.04, rad));
        diffuseColor.rgb = woodc;`,
      );
  };
  return mat;
}

// Base green the atlas is painted in — the seasonal tint uniform is expressed
// relative to it so summer stays neutral and autumn/winter re-hue the atlas.
const BASE_LEAF_RGB = new THREE.Color("#5aa238");

// Shared wind vertex code — injected into the visible leaf material AND the
// shadow depth material so dappled leaf shadows never drift against the
// leaves themselves.
const LEAF_WIND_PARS = `
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
attribute vec3 aLeaf;
varying vec3 vLeaf;
varying vec3 vWPos;
`;
const LEAF_WIND_VERTEX = `
vLeaf = aLeaf;
#ifdef USE_INSTANCING
  vec3 instPos = vec3(instanceMatrix[3].xyz);
#else
  vec3 instPos = vec3(0.0);
#endif
float lph = aLeaf.z * 6.2831853;
vec2 wdir = normalize(uWindDir);
vec2 wside = vec2(-wdir.y, wdir.x);
float hf = 0.35 + max(transformed.y, 0.0) * 0.6;
// Octave 1 — gust front: travels ACROSS the crown instead of pulsing globally.
float gustPhase = dot(instPos.xz, wdir) * 0.22 - uTime * 1.05;
float gustW = 0.55 + 0.45 * sin(gustPhase + lph * 0.6) * (0.7 + 0.3 * sin(uTime * 0.43 + lph));
// Octave 2 — branch-scale wave riding the gust front.
float branchWave = sin(gustPhase * 2.3 + lph * 2.0);
// Octave 3 — high-frequency leaf flutter, amplitude gated by the gust.
float flutter = sin(uTime * 6.8 + lph * 13.0 + position.y * 9.0) * (0.25 + 0.75 * gustW);
float downwind = (0.035 + branchWave * 0.02) * uWind * hf * gustW;
float lateral = (sin(uTime * 2.6 + lph * 1.7) * 0.016 + cos(uTime * 1.35 + lph) * 0.011) * uWind * hf;
transformed.x += wdir.x * downwind + wside.x * lateral;
transformed.z += wdir.y * downwind + wside.y * lateral;
transformed.y += sin(uTime * 1.6 + lph * 1.3) * 0.012 * uWind * hf;
transformed += normal * (flutter * 0.015 * uWind);
`;
// World position for the visible leaves' fragment effects (the depth pass
// doesn't need it). Two matrix-vector products rather than building
// modelMatrix * instanceMatrix per vertex, which costs ~3x the multiplies.
const LEAF_WORLD_POS = `
#ifdef USE_INSTANCING
  vWPos = (modelMatrix * (instanceMatrix * vec4(transformed, 1.0))).xyz;
#else
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif
`;

type LeafUniforms = {
  uTime: { value: number };
  uWind: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uSunDirW: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSSS: { value: number };
  uSnow: { value: number };
  uLeafTint: { value: THREE.Color };
  uWet: { value: number };
  uCloudCover: { value: number };
  uAerial: { value: number };
};

// Procedural leaf-card atlas (2×2 tiles): three veined leaf CLUSTERS plus one
// big single leaf, painted once per resolution and cached. Each canopy card
// samples one tile, so a single quad reads as 6–9 individual leaves. RGB is
// pre-flooded with mid-green so mipmaps never ring dark at the alpha edges.
const _leafAtlas = new Map<number, THREE.CanvasTexture>();
function getLeafAtlas(size: number): THREE.CanvasTexture {
  const cached = _leafAtlas.get(size);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskCanvas.height = size;
  const mctx = maskCanvas.getContext("2d")!;
  ctx.fillStyle = "#4d7a2e";
  ctx.fillRect(0, 0, size, size);
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, size, size);

  let seed = 11;
  const rnd = () => {
    seed += 1;
    const x = Math.sin(seed * 91.7 + 13.1) * 43758.5453;
    return x - Math.floor(x);
  };

  // One leaf: jittered teardrop outline, base→tip gradient, midrib + side
  // veins and a dark edge on the color canvas; plain white on the alpha mask.
  const leaf = (cx: number, cy: number, rot: number, len: number) => {
    const wHalf = len * (0.3 + rnd() * 0.08);
    const j = () => (rnd() - 0.5) * len * 0.05;
    const path = new Path2D();
    path.moveTo(0, 0);
    path.bezierCurveTo(wHalf + j(), -len * 0.25 + j(), wHalf * 0.82 + j(), -len * 0.78 + j(), 0, -len);
    path.bezierCurveTo(-wHalf * 0.82 + j(), -len * 0.78 + j(), -wHalf + j(), -len * 0.25 + j(), 0, 0);

    ctx.save();
    mctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    mctx.translate(cx, cy);
    mctx.rotate(rot);
    const grad = ctx.createLinearGradient(0, 0, 0, -len);
    const bright = 0.92 + rnd() * 0.16;
    const hueShift = Math.round((rnd() - 0.5) * 12);
    grad.addColorStop(0, `hsl(${96 + hueShift}, 47%, ${24 * bright}%)`);
    grad.addColorStop(1, `hsl(${88 + hueShift}, 44%, ${42 * bright}%)`);
    ctx.fillStyle = grad;
    ctx.fill(path);
    ctx.strokeStyle = "rgba(36, 61, 22, 0.4)";
    ctx.lineWidth = Math.max(1, size / 340);
    ctx.stroke(path);
    ctx.strokeStyle = "rgba(176, 214, 130, 0.55)";
    ctx.lineWidth = Math.max(1, size / 512);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -len * 0.92);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    const veins = 4 + Math.floor(rnd() * 3);
    for (let v = 1; v <= veins; v++) {
      const t = v / (veins + 1);
      const vy = -len * (0.15 + t * 0.7);
      const vl = wHalf * (1 - t) * 1.3;
      ctx.beginPath();
      ctx.moveTo(0, vy);
      ctx.lineTo(vl * 0.9, vy - vl * 0.55);
      ctx.moveTo(0, vy);
      ctx.lineTo(-vl * 0.9, vy - vl * 0.55);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    mctx.fillStyle = "#fff";
    mctx.fill(path);
    ctx.restore();
    mctx.restore();
  };

  const T = size / 2;
  for (let tile = 0; tile < 4; tile++) {
    const tx0 = (tile % 2) * T;
    const ty0 = Math.floor(tile / 2) * T;
    const clip = new Path2D();
    clip.rect(tx0, ty0, T, T);
    ctx.save();
    mctx.save();
    ctx.clip(clip);
    mctx.clip(clip);
    if (tile === 3) {
      leaf(tx0 + T / 2, ty0 + T * 0.86, (rnd() - 0.5) * 0.2, T * 0.72);
    } else {
      const n = 6 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.8;
        const d = T * (0.04 + rnd() * 0.1);
        leaf(
          tx0 + T / 2 + Math.cos(a) * d,
          ty0 + T / 2 + Math.sin(a) * d,
          a + Math.PI * 0.5,
          T * (0.28 + rnd() * 0.12),
        );
      }
    }
    ctx.restore();
    mctx.restore();
  }

  // Copy the mask into the alpha channel; RGB keeps the green ground.
  const img = ctx.getImageData(0, 0, size, size);
  const alpha = mctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = alpha.data[i];
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  _leafAtlas.set(size, tex);
  return tex;
}

// Leaf material: atlas-textured cards with a 3-octave wind field, crown-depth
// AO, sun-through-leaf translucency, snow dusting on up-facing cards, wet-rain
// gloss, drifting cloud shadows and a sky rim. Everything is uniform-driven —
// weather/season changes never recompile the shader.
function makeLeafMaterial(
  atlas: THREE.Texture,
  uniforms: LeafUniforms,
  alphaToCoverage: boolean,
  receivesShadows: boolean,
) {
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    map: atlas,
    alphaTest: 0.35,
    alphaToCoverage,
    roughness: 0.72,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    for (const [k, v] of Object.entries(uniforms)) shader.uniforms[k] = v;
    shader.vertexShader =
      LEAF_WIND_PARS +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${LEAF_WIND_VERTEX}\n${LEAF_WORLD_POS}`,
      );
    if (!receivesShadows) {
      // Below Ultra the canopy never receives shadows (receiveShadow is
      // always false), so the shadow-map coordinates and lookups it would
      // compute per vertex and per fragment are dropped from its shader.
      // The shadow factor was always 1.0, so the output doesn't change.
      shader.vertexShader = shader.vertexShader.replace("#include <shadowmap_vertex>", "");
      shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_begin>", () =>
        THREE.ShaderChunk.lights_fragment_begin.replaceAll("&& receiveShadow )", "&& false )"),
      );
    }
    shader.fragmentShader =
      `
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform vec3 uSunDirW;
uniform vec3 uSunColor;
uniform float uSSS;
uniform float uSnow;
uniform vec3 uLeafTint;
uniform float uWet;
uniform float uCloudCover;
uniform float uAerial;
varying vec3 vLeaf;
varying vec3 vWPos;
` +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
        // Warm/cool per-sprig variation + seasonal tint (uniform, no recompile).
        vec3 leafWarm = vec3(1.10, 1.04, 0.78);
        vec3 leafCool = vec3(0.84, 1.00, 1.08);
        diffuseColor.rgb *= uLeafTint * mix(leafCool, leafWarm, vLeaf.y) * (0.84 + vLeaf.y * 0.28);
        // Crown-depth AO: leaves deep inside the crown sit in their own shade.
        diffuseColor.rgb *= mix(0.52, 1.05, vLeaf.x);
        // Snow dust settles ONLY on upward-facing cards (mirror of Island uSnow).
        vec3 leafWN = inverseTransformDirection(normalize(vNormal), viewMatrix);
        float leafUp = smoothstep(0.15, 0.65, leafWN.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 1.00), uSnow * leafUp * 0.85);
        // Rain-wet foliage darkens...
        diffuseColor.rgb *= 1.0 - uWet * 0.25;
        ${CLOUD_SHADOW_FRAG}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
        // ...and turns glossy, so a low sun glints on wet leaves.
        roughnessFactor = max(0.15, roughnessFactor - uWet * 0.45);`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
        // Sun-through-leaf translucency: looking toward the sun through the
        // crown lights thin leaves up chlorophyll green-gold (golden hour!).
        vec3 sunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
        vec3 leafV = normalize(vViewPosition);
        float backlit = pow(clamp(dot(leafV, -sunV), 0.0, 1.0), 2.5);
        float thin = 0.55 + 0.45 * vLeaf.y;
        totalEmissiveRadiance += uSunColor * (backlit * uSSS * thin * vLeaf.x) * diffuseColor.rgb * vec3(0.90, 1.00, 0.45);
        // Sky rim keeps the crown silhouette readable against the dome.
        float rim = pow(1.0 - clamp(dot(leafV, normalize(vNormal)), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += rim * uSunColor * 0.06 * vLeaf.x;
        // Aerial perspective: a warm sun-lit haze builds on the DISTANT crown as
        // a depth cue. Purely additive — it can only add light, never blank the
        // canopy — and it's gated by uAerial (0 on low/medium).
        if (uAerial > 0.0) {
          float aeD = length(vWPos - cameraPosition);
          float aeHaze = (1.0 - exp(-aeD * 0.013)) * uAerial;
          vec3 aeView = normalize(vWPos - cameraPosition);
          float aeSun = max(dot(aeView, normalize(uSunDirW)), 0.0);
          totalEmissiveRadiance += uSunColor * aeHaze * (0.2 + 0.8 * pow(aeSun, 3.0)) * 0.5;
        }`,
        );
  };
  // The shader source depends on receivesShadows, so it must be in the key.
  mat.customProgramCacheKey = () => `leaf:${receivesShadows}`;
  return mat;
}

// Leaf sprig geometry used by each canopy instance: 24 gently folded quad
// cards (4 tris each), each UV-mapped to one atlas tile so a single card reads as a small leaf cluster.
// Soft "volume" normals make the crown shade like a rounded mass instead of a
// pile of flat cards.
function makeLeafSprigGeometry(): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const N = 24;
  let seed = 5;
  const rnd = () => {
    seed += 1;
    const x = Math.sin(seed * 91.7 + 13.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const sprigCenter = new THREE.Vector3(0, 0.3, 0);
  const center = new THREE.Vector3();
  const vtx = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const g = new THREE.PlaneGeometry(0.46, 0.6, 1, 2);
    g.translate(0, 0.3, 0); // base at the twig anchor, card grows upward
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    // Gentle fold: the middle vertex row pops forward.
    for (let v = 0; v < pos.count; v++) {
      if (Math.abs(pos.getY(v) - 0.3) < 0.01) pos.setZ(v, 0.06);
    }
    // Atlas tile: mostly clusters, occasionally the big single leaf. Canvas
    // row 0 is the TOP of the texture (flipY), i.e. v in [0.5, 1].
    const tile = rnd() < 0.12 ? 3 : Math.floor(rnd() * 3);
    const tx = tile % 2;
    const ty = 1 - Math.floor(tile / 2);
    const mirror = rnd() < 0.5;
    const uv = g.getAttribute("uv") as THREE.BufferAttribute;
    for (let v = 0; v < uv.count; v++) {
      const u = mirror ? 1 - uv.getX(v) : uv.getX(v);
      uv.setXY(v, (tx + u) * 0.5, (ty + uv.getY(v)) * 0.5);
    }
    g.rotateX(-0.45 - (i % 5) * 0.15);
    g.rotateY(i * 2.39996 + 0.5);
    g.translate((i % 4 - 1.5) * 0.045, 0.26 + (i % 7) * 0.018, ((i * 7) % 7 - 3) * 0.032);
    const cnt = pos.count;
    const shade = 0.68 + (i % 7) * 0.055;
    g.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(cnt * 3).fill(shade), 3),
    );
    // Soft volume normals: away from the sprig core, blended toward up.
    center.set(0, 0, 0);
    for (let v = 0; v < cnt; v++) center.add(vtx.fromBufferAttribute(pos, v));
    center.divideScalar(cnt);
    const soft = center.clone().sub(sprigCenter);
    if (soft.lengthSq() < 1e-4) soft.set(0, 1, 0);
    soft.normalize().lerp(UP, 0.4).normalize();
    const nor = g.getAttribute("normal") as THREE.BufferAttribute;
    for (let v = 0; v < nor.count; v++) nor.setXYZ(v, soft.x, soft.y, soft.z);
    geos.push(g);
  }
  return mergeGeometries(geos, false);
}

function makePlanterGeometry() {
  const g = new THREE.Group();
  const ceramic = new THREE.MeshStandardMaterial({
    color: "#e7dfd3",
    roughness: 0.76,
  });
  const ceramicDark = new THREE.MeshStandardMaterial({
    color: "#b8ac9c",
    roughness: 0.82,
  });
  const moss = new THREE.MeshStandardMaterial({
    color: "#52683d",
    roughness: 0.95,
  });
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(2.8, 2.42, 0.68, 64, 1, true),
    ceramic,
  );
  bowl.position.y = -0.4;
  bowl.castShadow = true;
  bowl.receiveShadow = true;
  g.add(bowl);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.13, 10, 64), ceramic);
  rim.position.y = -0.05;
  rim.rotation.x = Math.PI / 2;
  rim.castShadow = true;
  g.add(rim);

  const foot = new THREE.Mesh(
    new THREE.CylinderGeometry(2.16, 2.22, 0.18, 48),
    ceramicDark,
  );
  foot.position.y = -0.82;
  foot.castShadow = true;
  g.add(foot);

  const soil = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.38, 0.1, 48), moss);
  soil.position.y = -0.06;
  soil.receiveShadow = true;
  g.add(soil);
  return g;
}

export function Tree({
  stars,
  wind = 1,
  gust = 0,
  windVec = [1, 0],
  leafColor = "#5aa238",
  snow = 0,
  twilight = 0,
  sunDir = [12, 18, 8],
  sunColor = "#fff2d8",
  sunIntensity = 1,
  wet = 0,
  cloudCover = 0,
  forceProxyShadows = false,
  leafDensity = 1,
  stargazers = null,
  children,
  ...props
}: {
  stars: number;
  wind?: number;
  gust?: number;
  windVec?: [number, number];
  leafColor?: string;
  snow?: number;
  twilight?: number;
  sunDir?: [number, number, number];
  sunColor?: string;
  sunIntensity?: number;
  wet?: number;
  cloudCover?: number;
  forceProxyShadows?: boolean;
  /** Share of leaf sprigs drawn; lowered by adaptive quality on weak GPUs. */
  leafDensity?: number;
  stargazers?: { tier?: Tier }[] | null;
} & ThreeElements["group"]) {
  const swayRef = useRef<THREE.Group>(null);
  const trunkRef = useRef<THREE.Group>(null);
  const branchRefs = useRef<(THREE.Group | null)[]>([]);
  const quality = useQualityProfile();
  const sprigDensity = quality.sprigDensity;
  const nodes = useMemo(() => bonsaiNodes(MAX_HOUSES), []);
  const active = Math.min(MAX_HOUSES, Math.max(0, Math.floor(stars)));
  // The 5-minute stargazer sync delivers a NEW array with the same tiers —
  // key the expensive canopy rebuild on the tier content, not array identity.
  const tierKey = useMemo(
    () => stargazers?.map((s) => s.tier ?? "").join("|") ?? "",
    [stargazers],
  );
  const sprigGeo = useMemo(makeLeafSprigGeometry, []);
  // Shared uniforms for batched canopy motion + shading. ONE object feeds the
  // visible leaf material AND the shadow depth material.
  const windUniforms = useRef<LeafUniforms>({
    uTime: { value: 0 },
    uWind: { value: 1 },
    uWindDir: { value: new THREE.Vector2(windVec[0], windVec[1]) },
    uSunDirW: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color("#fff2d8") },
    uSSS: { value: 0.2 },
    uSnow: { value: 0 },
    uLeafTint: { value: new THREE.Color("#ffffff") },
    uWet: { value: 0 },
    uCloudCover: { value: 0 },
    uAerial: { value: 0 },
  });

  // The bark texture and the collision-aware canopy (merged twigs + instanced
  // leaf sprigs) are generated in workers (lib/treeWorkerClient.ts). Both jobs
  // are requested before suspending on either, so they run side by side.
  const barkRequest: Promise<BarkTextures> = requestBarkTextures(quality.barkTexSize);
  const canopyInput = useMemo<CanopyInput>(
    () => ({
      active,
      stars,
      sprigDensity,
      budgetScale: quality.canopyBudgetScale,
      deckRadii: Array.from({ length: active }, (_, i) => deckRadius(i, stargazers)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tierKey captures the only stargazer data used (deck tiers)
    [active, stars, sprigDensity, quality.canopyBudgetScale, tierKey],
  );
  const canopy = useCanopy(canopyInput);
  const barkTextures = use(barkRequest);

  const materials = useMemo(
    () => ({
      bark: makeBarkMaterial(barkTextures),
      ringCap: makeRingCapMaterial(),
      leaf: makeLeafMaterial(
        getLeafAtlas(quality.leafAtlasSize),
        windUniforms.current,
        quality.antialias,
        quality.canopySelfShadow,
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quality is fixed per Canvas mount (tier change remounts)
    [],
  );

  // Real leaf-shaped shadows (high/extreme): the depth pass runs the SAME
  // wind chunk + alpha test as the visible leaves, so the dappled shadows
  // sway in lockstep instead of drifting.
  const realShadows = quality.leafShadows === "real" && !forceProxyShadows;
  const leafDepthMaterial = useMemo(() => {
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: getLeafAtlas(quality.leafAtlasSize),
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = windUniforms.current.uTime;
      shader.uniforms.uWind = windUniforms.current.uWind;
      shader.uniforms.uWindDir = windUniforms.current.uWindDir;
      shader.vertexShader =
        LEAF_WIND_PARS +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${LEAF_WIND_VERTEX}`,
        );
    };
    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quality is fixed per Canvas mount
  }, []);

  useEffect(() => {
    const u = windUniforms.current;
    // Seasonal tint relative to the atlas base green (summer ≈ identity).
    const tint = new THREE.Color(leafColor);
    u.uLeafTint.value.setRGB(
      tint.r / BASE_LEAF_RGB.r,
      tint.g / BASE_LEAF_RGB.g,
      tint.b / BASE_LEAF_RGB.b,
    );
    u.uSnow.value = Math.min(1, snow);
    u.uSunColor.value.set(sunColor);
    // Translucency swells toward the golden hour and dies with the sun.
    u.uSSS.value =
      (0.16 + twilight * 0.85) * THREE.MathUtils.clamp(sunIntensity, 0, 1);
    u.uAerial.value = quality.aerial;
  }, [leafColor, snow, twilight, sunColor, sunIntensity, quality.aerial]);

  // Trunk follows the procedural spine and grows with the tower. All static
  // wood (trunk + stubs, roots, ring caps) is merged into ONE geometry per
  // material — 3 draw calls instead of 17.
  const trunkH = trunkHeight(stars);
  const trunkR = trunkBaseRadius(stars);
  const woodGeos = useMemo(() => {
    const H = trunkH;
    const baseR = trunkR;
    const barkGeos: THREE.BufferGeometry[] = [];
    const capGeos: THREE.BufferGeometry[] = [];

    const segs = THREE.MathUtils.clamp(Math.round(H * 2), 24, 220);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) pts.push(spineAt((i / segs) * H));
    barkGeos.push(makeTaperedTubeGeometry(pts, baseR, baseR * 0.24, segs, 18, 0.5, 0.7));

    // Small branch stubs break up the trunk silhouette.
    const specs = [
      { y: 1.4, ang: 0.6, len: 0.6, r: 0.22, up: 0.3 },
      { y: 2.4, ang: 3.7, len: 0.42, r: 0.16, up: 0.36 },
      { y: 3.4, ang: 2.3, len: 0.5, r: 0.18, up: 0.42 },
      { y: 4.6, ang: 4.5, len: 0.4, r: 0.15, up: 0.5 },
      { y: 6.0, ang: 1.3, len: 0.36, r: 0.13, up: 0.54 },
      { y: 7.6, ang: 5.6, len: 0.32, r: 0.12, up: 0.6 },
    ].filter((s) => s.y < H - 0.5);
    const trunkRadiusAt = (y: number) =>
      Math.max(0.12, baseR * Math.pow(1 - THREE.MathUtils.clamp(y / H, 0, 1), 0.72));
    specs.forEach((s, i) => {
      const center = spineAt(s.y);
      const radial = new THREE.Vector3(Math.cos(s.ang), 0, Math.sin(s.ang));
      const dir = radial.clone().add(new THREE.Vector3(0, s.up, 0)).normalize();
      const rT = trunkRadiusAt(s.y);
      const base = center.clone().addScaledVector(radial, rT * 0.5);
      const mid = center.clone().addScaledVector(dir, rT * 0.8 + s.len * 0.45);
      const tip = center.clone().addScaledVector(dir, rT * 0.85 + s.len);
      const rEnd = s.r * 0.82;
      barkGeos.push(makeTaperedTubeGeometry([base, mid, tip], s.r, rEnd, 10, 9, i * 0.7));
      const cap = new THREE.CircleGeometry(rEnd * 1.05, 18);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const capPos = tip.clone().addScaledVector(dir, 0.004);
      cap.applyMatrix4(new THREE.Matrix4().compose(capPos, quat, new THREE.Vector3(1, 1, 1)));
      capGeos.push(cap);
    });

    const spread = 1 + baseR * 1.3;
    const rootGeos = Array.from({ length: 10 }, (_, i) => {
      const a = i * 0.628 + 0.2;
      const p0 = spineAt(0).add(
        new THREE.Vector3(Math.cos(a) * baseR * 0.5, -0.03, Math.sin(a) * baseR * 0.5),
      );
      const p1 = new THREE.Vector3(Math.cos(a) * spread * 0.6, -0.12, Math.sin(a) * spread * 0.6);
      const p2 = new THREE.Vector3(
        Math.cos(a) * (spread + (i % 3) * 0.18),
        -0.2,
        Math.sin(a) * (spread * 0.78 + (i % 2) * 0.14),
      );
      return makeTaperedTubeGeometry([p0, p1, p2], baseR * 0.35, 0.06, 18, 7, i * 0.7);
    });

    return {
      bark: mergeGeometries(barkGeos, false),
      roots: mergeGeometries(rootGeos, false),
      caps: capGeos.length ? mergeGeometries(capGeos, false) : null,
    };
  }, [trunkH, trunkR]);
  // The trunk is rebuilt whenever the star count changes; free the old buffers.
  useEffect(
    () => () => {
      woodGeos.bark.dispose();
      woodGeos.roots.dispose();
      woodGeos.caps?.dispose();
    },
    [woodGeos],
  );

  const branchPieces = useMemo(() => {
    return nodes.map((node) => {
      const branchGeo = makeTaperedTubeGeometry(
        [
          node.base.clone().sub(node.base),
          node.elbow.clone().sub(node.base),
          node.tip.clone().sub(node.base),
        ],
        node.radius * 1.08,
        node.radius * 0.24,
        30,
        8,
        node.phase,
      );
      return { node, branchGeo };
    });
  }, [nodes]);
  useEffect(() => () => branchPieces.forEach((p) => p.branchGeo.dispose()), [branchPieces]);

  const planter = useMemo(makePlanterGeometry, []);

  // Bounds for the cheap canopy shadow proxy.
  const crownBounds = useMemo(() => {
    let maxReach = 3.6;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < active; i++) {
      const t = nodes[i].tip;
      maxReach = Math.max(maxReach, Math.hypot(t.x, t.z) + deckRadius(i, stargazers));
      minY = Math.min(minY, t.y);
      maxY = Math.max(maxY, t.y);
    }
    if (!isFinite(minY)) {
      minY = 7.5;
      maxY = 8.5;
    }
    return {
      cy: (minY + maxY) / 2 + 0.6,
      rx: maxReach + 1.8,
      ry: (maxY - minY) / 2 + 2.8,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tierKey captures the only stargazer data used (deck tiers)
  }, [active, nodes, tierKey]);

  const canopyBranches = useMemo(() => {
    if (!canopy.branch) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(canopy.branch.position, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(canopy.branch.normal, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(canopy.branch.uv, 2));
    g.setIndex(new THREE.BufferAttribute(canopy.branch.index, 1));
    return g;
  }, [canopy]);
  useEffect(() => () => canopyBranches?.dispose(), [canopyBranches]);

  const firstBranchRun = useRef(true);
  useEffect(() => {
    const skipIntro = firstBranchRun.current && growIntroPlayed;
    firstBranchRun.current = false;
    branchRefs.current.forEach((group, i) => {
      if (!group) return;
      const on = i < active;
      if (skipIntro) {
        group.visible = on;
        group.scale.setScalar(on ? 1 : 0.001);
        return;
      }
      if (on) group.visible = true;
      gsap.to(group.scale, {
        x: on ? 1 : 0.001,
        y: on ? 1 : 0.001,
        z: on ? 1 : 0.001,
        duration: on ? 0.85 : 0.35,
        delay: on ? i * 0.025 : 0,
        ease: on ? "back.out(1.35)" : "power2.in",
        overwrite: true,
        onComplete: () => {
          if (!on) group.visible = false;
        },
      });
    });
  }, [active, stars]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Slow gust modulation for natural canopy motion.
    const gustWave =
      0.72 +
      0.18 * Math.sin(t * 0.45) +
      0.08 * Math.sin(t * 1.7 + 1.1) +
      gust * 0.18 * Math.sin(t * 0.9 + 0.4);
    const w = wind * gustWave;
    // Drive the batched leaf shader.
    const u = windUniforms.current;
    u.uTime.value = t;
    u.uWind.value = w;
    u.uWindDir.value.set(windVec[0], windVec[1]).normalize();
    u.uSunDirW.value.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
    u.uWet.value = wet;
    u.uCloudCover.value = cloudCover;
    if (!swayRef.current) return;
    // Lean the whole crown downwind.
    const lean = Math.min(0.12, 0.012 + wind * 0.028 + gust * 0.012) * gustWave;
    const side = Math.sin(t * (0.62 + wind * 0.12)) * 0.012 * wind;
    swayRef.current.rotation.z = -windVec[0] * lean + windVec[1] * side;
    swayRef.current.rotation.x = windVec[1] * lean + windVec[0] * side * 0.55;
    // Per-branch flex lives in the leaf vertex shader (gust field) — no CPU
    // rotation loop per frame; branchRefs only drive the grow-in animation.
  });

  // Must stay after the grow effects above so they still see the first mount.
  useEffect(() => {
    growIntroPlayed = true;
  }, []);

  // Small intro settle without changing platform spacing.
  const { scale } = useSpring({
    from: { scale: growIntroPlayed ? 1 : 0.92 },
    to: { scale: 1 },
    config: { mass: 1, tension: 110, friction: 25 },
  });

  return (
    <animated.group scale={scale} {...props}>
      <primitive object={planter} />
      <group ref={swayRef}>
        <group ref={trunkRef}>
          <mesh geometry={woodGeos.bark} material={materials.bark} castShadow receiveShadow />
          <mesh geometry={woodGeos.roots} material={materials.bark} castShadow receiveShadow />
          {woodGeos.caps && (
            <mesh geometry={woodGeos.caps} material={materials.ringCap} castShadow />
          )}
        </group>

        {branchPieces.map(({ node, branchGeo }) => (
          <group
            key={node.index}
            ref={(g) => {
              branchRefs.current[node.index] = g;
            }}
            position={node.base}
            scale={0.001}
            visible={false}
          >
            <mesh geometry={branchGeo} material={materials.bark} castShadow receiveShadow />
          </group>
        ))}

        {/* Merged procedural branch skeleton (casts twig shadows between the
            leaf dapples when real shadows are on — it is ONE mesh). */}
        {active > 0 && canopyBranches && (
          <mesh
            geometry={canopyBranches}
            material={materials.bark}
            castShadow={realShadows}
          />
        )}

        {/* Instanced canopy leaves. */}
        <LeafClumps
          sprigs={canopy.sprigs}
          geometry={sprigGeo}
          material={materials.leaf}
          depthMaterial={realShadows ? leafDepthMaterial : undefined}
          grown={active > 0}
          density={leafDensity}
          castShadow={realShadows}
          receiveShadow={realShadows && quality.canopySelfShadow}
        />

        {/* Cheap canopy shadow proxy (low/medium or perf fallback). */}
        {active > 0 && !realShadows && (
          <mesh
            position={[0, crownBounds.cy, 0]}
            scale={[crownBounds.rx * 0.9, crownBounds.ry * 0.9, crownBounds.rx * 0.9]}
            castShadow
          >
            <icosahedronGeometry args={[1, 1]} />
            <meshBasicMaterial colorWrite={false} depthWrite={false} />
          </mesh>
        )}

        {children}
      </group>
    </animated.group>
  );
}
