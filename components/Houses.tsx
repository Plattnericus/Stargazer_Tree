"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import gsap from "gsap";
import { TIER_BUILDING, TIER_COLOR, TIER_SIZE, Tier, deckRadius, resolveTier } from "@/lib/rarity";
import { MAX_HOUSES } from "@/lib/layout";
import { bonsaiAnchors, type BonsaiAnchor as Anchor } from "@/lib/bonsai";
import {
  buildLantern,
  setLanternGlow,
  LANTERN_LIGHT_THRESHOLD,
  LANTERN_SIZE,
  NIGHT_LIGHT,
} from "@/lib/lantern";
import { nameForIndex } from "@/lib/names";
import type { Stargazer } from "@/lib/stargazers";
import { useI18n, type MsgKey } from "@/lib/i18n";
import { freezeTransforms } from "@/lib/matrixUpdates";

const PACK = "/models/casual_village_buildings_pack.glb";
const LANTERN = "/models/stylized_lantern.glb";
const LANTERN_ROT = 0; // model is already Y-up; no rotation keeps it standing
// Only the first few houses get a real (forward-rendered) point light at night —
// every other lantern still glows via baked emissive. Point lights compile into
// every standard material's shader, so capping them is a big fragment-cost win.
const LIT_HOUSES = 7;
const EXTRA_LANTERNS = 10;
const EXTRA_LIT_LANTERNS = 4;

function rand(seed: number) {
  const x = Math.sin(seed * 53.17 + 11.3) * 43758.5453;
  return x - Math.floor(x);
}

const WOOD_NOISE = /* glsl */ `
  float whash(vec3 p){ return fract(sin(dot(p, vec3(17.17, 41.93, 9.71))) * 43758.5453); }
  float wnoise(vec3 p){
    vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(whash(i),whash(i+vec3(1,0,0)),f.x),
                   mix(whash(i+vec3(0,1,0)),whash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(whash(i+vec3(0,0,1)),whash(i+vec3(1,0,1)),f.x),
                   mix(whash(i+vec3(0,1,1)),whash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
`;

function makeWoodMaterial(base = "#8a572f", dark = "#4c2c17") {
  const mat = new THREE.MeshStandardMaterial({
    color: base,
    roughness: 0.82,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "varying vec3 vWoodPos;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n vWoodPos = position;",
      );
    shader.fragmentShader =
      "varying vec3 vWoodPos;\n" +
      WOOD_NOISE +
      shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float rings = sin(length(vWoodPos.xz) * 18.0 + wnoise(vWoodPos * 5.0) * 3.0);
        float grain = wnoise(vec3(vWoodPos.x * 2.4, vWoodPos.y * 9.0, vWoodPos.z * 14.0));
        float boards = smoothstep(0.025, 0.0, abs(fract(vWoodPos.x * 1.25 + 0.5) - 0.5));
        vec3 warm = vec3(0.55, 0.33, 0.16);
        vec3 honey = vec3(0.78, 0.51, 0.25);
        vec3 deep = vec3(0.27, 0.15, 0.08);
        vec3 wood = mix(warm, honey, grain * 0.65 + rings * 0.12);
        wood = mix(wood, deep, boards * 0.42);
        diffuseColor.rgb = mix(diffuseColor.rgb, wood, 0.88);`,
      );
  };
  return mat;
}

// Clean round wooden platform with railing. Deck top is y=0 so the house sits
// on it; the material is procedural wood so all treehouse pieces match.
const WOOD = makeWoodMaterial();
const WOOD_DARK = makeWoodMaterial("#56331b", "#24140b");
const WOOD_GROOVE = new THREE.MeshStandardMaterial({
  color: "#2f1a0d",
  roughness: 0.9,
});

type PlatformGeometry = {
  deck: THREE.BufferGeometry;
  grooves: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
};

// Deck radius only depends on the tier, so there are just four distinct
// platforms; every house of a tier shares the same buffers.
const platformGeometryCache = new Map<number, PlatformGeometry>();

function platformGeometry(deckR: number): PlatformGeometry {
  const cached = platformGeometryCache.get(deckR);
  if (cached) return cached;
  const m = new THREE.Matrix4();

  // deck slab (WOOD)
  const deck = new THREE.CylinderGeometry(deckR, deckR * 0.92, 0.34, 36);
  deck.translate(0, -0.17, 0);

  // plank grooves (WOOD_GROOVE) — merged
  const grooveGeos: THREE.BufferGeometry[] = [];
  for (let i = -3; i <= 3; i++) {
    const z = (i / 3.8) * deckR;
    const chord = Math.sqrt(Math.max(0.1, deckR * deckR - z * z)) * 1.72;
    const gg = new THREE.BoxGeometry(chord, 0.018, 0.028);
    gg.translate(0, 0.012, z);
    grooveGeos.push(gg);
  }
  const grooves = mergeGeometries(grooveGeos, false);

  // rim + rail + railing posts (WOOD_DARK) — merged
  const darkGeos: THREE.BufferGeometry[] = [];
  const rim = new THREE.TorusGeometry(deckR * 0.99, 0.055, 8, 36);
  rim.applyMatrix4(m.makeRotationX(Math.PI / 2).setPosition(0, 0.02, 0));
  darkGeos.push(rim);
  const rail = new THREE.TorusGeometry(deckR * 0.97, 0.05, 8, 36);
  rail.applyMatrix4(m.makeRotationX(Math.PI / 2).setPosition(0, 0.5, 0));
  darkGeos.push(rail);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const post = new THREE.CylinderGeometry(0.045, 0.05, 0.58, 6);
    post.translate(Math.cos(a) * deckR * 0.95, 0.25, Math.sin(a) * deckR * 0.95);
    darkGeos.push(post);
  }
  const dark = mergeGeometries(darkGeos, false);

  const result = { deck, grooves, dark };
  platformGeometryCache.set(deckR, result);
  return result;
}

// Built as 3 merged meshes (one per material) instead of ~17 separate ones, so a
// village of 40 houses costs ~120 platform draw calls, not ~680.
function makePlatform(deckR: number): THREE.Group {
  const geo = platformGeometry(deckR);
  const g = new THREE.Group();

  const deck = new THREE.Mesh(geo.deck, WOOD);
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);

  const grooves = new THREE.Mesh(geo.grooves, WOOD_GROOVE);
  grooves.receiveShadow = true;
  g.add(grooves);

  const dark = new THREE.Mesh(geo.dark, WOOD_DARK);
  dark.castShadow = true;
  g.add(dark);

  freezeTransforms(g);
  return g;
}

// The village pack ships every building on a MeshPhysicalMaterial (clearcoat +
// transmission machinery runs per-fragment even though these flat low-poly props
// use none of it). Rebuild as a plain MeshStandardMaterial — visually identical
// for these matte props, but a much cheaper fragment shader across every house.
function toStandard(src: THREE.Material): THREE.MeshStandardMaterial {
  const p = src as THREE.MeshStandardMaterial; // physical extends standard, so these all exist
  const m = new THREE.MeshStandardMaterial({
    color: p.color?.clone(),
    map: p.map ?? null,
    normalMap: p.normalMap ?? null,
    roughness: p.roughness ?? 0.9,
    metalness: p.metalness ?? 0,
    emissive: p.emissive?.clone() ?? new THREE.Color(0x000000),
    emissiveMap: p.emissiveMap ?? null,
    emissiveIntensity: p.emissiveIntensity ?? 1,
    vertexColors: p.vertexColors ?? false,
    transparent: p.transparent ?? false,
    opacity: p.opacity ?? 1,
    side: p.side ?? THREE.FrontSide,
  });
  return m;
}

type BuildFn = (tier: Tier) => THREE.Group | null;

function useBuildingFactory(): BuildFn {
  const { scene } = useGLTF(PACK);
  return useMemo(() => {
    const geos = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }>();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh)
        geos.set(o.name, { geo: o.geometry, mat: o.material as THREE.Material });
    });
    return (tier: Tier) => {
      const src = geos.get(TIER_BUILDING[tier]);
      if (!src) return null;
      // The geometry is shared by every house of this tier (it's never
      // modified); the material is per house so hover can brighten just one.
      const mesh = new THREE.Mesh(src.geo, toStandard(src.mat));
      mesh.castShadow = true;
      mesh.rotation.x = -Math.PI / 2; // Z-up -> Y-up
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const s = TIER_SIZE[tier] / Math.max(size.x, size.z);
      const g = new THREE.Group();
      g.add(mesh);
      g.scale.setScalar(s);
      mesh.position.set(-center.x, -box.min.y, -center.z);
      // The group gets a position prop from React, so only the mesh is frozen.
      freezeTransforms(mesh);
      return g;
    };
  }, [scene]);
}

// One house: stable geometry (built once), with a GSAP hover glow + scale pop
// and a floating name label. Hover state is local so only this house re-renders.
function House({
  i,
  anchor,
  tier,
  active,
  focused,
  night,
  name,
  contributor = false,
  makeBuilding,
  lanternScene,
  interactive,
  onSelect,
  setRef,
}: {
  i: number;
  anchor: Anchor;
  tier: Tier;
  active: boolean;
  focused: boolean;
  night: number;
  name: string;
  contributor?: boolean;
  makeBuilding: BuildFn;
  lanternScene: THREE.Object3D;
  interactive: boolean;
  onSelect?: (i: number) => void;
  setRef: (i: number, g: THREE.Group | null) => void;
}) {
  const { t } = useI18n();
  const size = TIER_SIZE[tier];
  const [hovered, setHovered] = useState(false);
  const innerRef = useRef<THREE.Group>(null);
  // Houses that already exist mount at full size; only new ones grow in. This
  // also matters for walk mode, where the colliders are cooked from whatever
  // is visible at mount: a house still at scale 0 would produce a garbage
  // collider, and hidden inactive houses produce none.
  const mountScale = useRef(active ? 1 : 0).current;

  // Built once and reused — hover re-renders don't rebuild the meshes.
  const built = useMemo(() => {
    const building = makeBuilding(tier);
    const deckR = size * 1.5;
    const platform = makePlatform(deckR);
    // Collect the building's own (cloned) materials so we can brighten just this
    // house on hover — the shared platform wood is left untouched.
    const mats: THREE.MeshStandardMaterial[] = [];
    building?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && "emissiveIntensity" in m) {
          m.emissive = new THREE.Color("#fff0d6");
          m.emissiveIntensity = 0;
          mats.push(m);
        }
      }
    });
    const la = rand(i) * Math.PI * 2;
    const lr = deckR * (0.45 + 0.32 * rand(i + 5));
    return { building, platform, deckR, mats, la, lr };
  }, [tier, size, makeBuilding, i]);
  useEffect(() => () => built.mats.forEach((m) => m.dispose()), [built]);

  // Pointer handlers go away with `interactive` (fly/walk), so pointer-out
  // never fires; drop the hover state and cursor ourselves.
  useEffect(() => {
    if (interactive || !hovered) return;
    setHovered(false);
    document.body.style.cursor = "auto";
  }, [interactive, hovered]);

  // Built ONCE — rebuilding clones the whole model per night change (lag).
  const lantern = useMemo(
    () => buildLantern(lanternScene, LANTERN_SIZE, LANTERN_ROT, 1),
    [lanternScene],
  );
  // Glow tracks day/night without any rebuild.
  useEffect(() => {
    setLanternGlow(lantern, 0.2 + night * 2.2);
  }, [lantern, night]);

  // Hover → brighten (emissive) + a subtle scale pop, eased with GSAP.
  useEffect(() => {
    const attention = hovered || focused;
    const glow = { v: built.mats[0]?.emissiveIntensity ?? 0 };
    const t1 = gsap.to(glow, {
      v: attention ? 0.18 : 0, // just a touch brighter, not a flashbang
      duration: 0.35,
      ease: "power2.out",
      onUpdate: () => built.mats.forEach((m) => (m.emissiveIntensity = glow.v)),
    });
    let t2: gsap.core.Tween | undefined;
    if (innerRef.current) {
      const s = attention ? 1.035 : 1;
      t2 = gsap.to(innerRef.current.scale, {
        x: s,
        y: s,
        z: s,
        duration: 0.3,
        ease: "power2.out",
      });
    }
    return () => {
      t1.kill();
      t2?.kill();
    };
  }, [hovered, focused, built]);

  const lightsOn = night > LANTERN_LIGHT_THRESHOLD;
  const eventHandlers = interactive
    ? {
        onClick: (e: ThreeEvent<MouseEvent>) => {
          if (!active) return;
          e.stopPropagation();
          onSelect?.(i);
        },
        onPointerOver: (e: ThreeEvent<PointerEvent>) => {
          if (!active) return;
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        },
        onPointerOut: (e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          setHovered(false);
          document.body.style.cursor = "auto";
        },
      }
    : {};
  return (
    <group
      ref={(g) => setRef(i, g)}
      position={anchor.pos}
      rotation={[0, i * 1.7, 0]}
      scale={mountScale}
      visible={mountScale > 0}
      {...eventHandlers}
    >
      <group ref={innerRef}>
        {built.platform && <primitive object={built.platform} />}
        {built.building && <primitive object={built.building} position={[0, 0.04, 0]} />}
        <group position={[Math.cos(built.la) * built.lr, 0.04, Math.sin(built.la) * built.lr]}>
          <primitive object={lantern} />
          {/* Stays mounted; only visible at night (see NIGHT_LIGHT). */}
          {i < LIT_HOUSES && (
            <pointLight
              name={NIGHT_LIGHT}
              visible={lightsOn}
              color="#ffb765"
              position={[0, size * 0.45, 0]}
              intensity={active && lightsOn ? 6 * night : 0}
              distance={size * 4.5}
              decay={2}
            />
          )}
        </group>
      </group>

      {hovered && active && (
        <Html
          position={[0, size * 1.7 + 1.05, 0]}
          center
          distanceFactor={9}
          zIndexRange={[20, 0]}
          pointerEvents="none"
          wrapperClass="select-none"
        >
          <div className="anim-fade pointer-events-none whitespace-nowrap rounded-xl border border-white/15 bg-[#0d141d]/95 px-3 py-1.5 text-white shadow-lg shadow-black/40">
            <div className="text-[13px] font-medium">
              {name}
              <span className="ml-px text-white/40">↗</span>
            </div>
            <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[10px] font-bold uppercase tracking-wide">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: TIER_COLOR[tier] }}
              />
              <span style={{ color: TIER_COLOR[tier] }}>
                {t(("tier." + tier) as MsgKey)}
              </span>
              {contributor && <span className="text-[#e0b25c]">· {t("search.contributor")}</span>}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

function ExtraDeckLanterns({
  anchors,
  active,
  night,
  stargazers,
  lanternScene,
  moving = false,
}: {
  anchors: Anchor[];
  active: number;
  night: number;
  stargazers?: Stargazer[] | null;
  lanternScene: THREE.Object3D;
  moving?: boolean;
}) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const frameSkip = useRef(0);
  const items = useMemo(() => {
    const out: {
      i: number;
      y: number;
      phase: number;
      yaw: number;
      x: number;
      z: number;
      lantern: THREE.Group;
    }[] = [];
    for (let i = LIT_HOUSES; i < active && out.length < EXTRA_LANTERNS; i++) {
      if ((i - LIT_HOUSES) % 2 !== 0 && rand(i + 91) > 0.35) continue;
      const anchor = anchors[i];
      const r = deckRadius(i, stargazers);
      const angle = rand(i + 211) * Math.PI * 2;
      const radius = r * (0.72 + rand(i + 33) * 0.18);
      out.push({
        i,
        y: anchor.pos.y + 0.42,
        phase: i,
        yaw: -angle + Math.PI * 0.5,
        x: anchor.pos.x + Math.cos(angle) * radius,
        z: anchor.pos.z + Math.sin(angle) * radius,
        lantern: buildLantern(lanternScene, LANTERN_SIZE * 0.92, LANTERN_ROT, 1),
      });
    }
    return out;
  }, [active, anchors, lanternScene, stargazers]);

  // Glow tracks day/night without rebuilding the lantern clones.
  useEffect(() => {
    for (const item of items) setLanternGlow(item.lantern, 0.25 + night * 2.6);
  }, [items, night]);

  useLayoutEffect(() => {
    for (let k = 0; k < items.length; k++) {
      const g = refs.current[k];
      if (!g) continue;
      const item = items[k];
      g.position.set(item.x, item.y, item.z);
      g.rotation.y = item.yaw;
      g.visible = true;
    }
  }, [items]);

  useFrame((state) => {
    if (moving) {
      frameSkip.current = (frameSkip.current + 1) % 2;
      if (frameSkip.current !== 0) return;
    } else {
      frameSkip.current = 0;
    }
    const t = state.clock.elapsedTime;
    for (let k = 0; k < items.length; k++) {
      const g = refs.current[k];
      if (!g) continue;
      const item = items[k];
      g.position.y = item.y + Math.sin(t * 0.75 + item.phase) * 0.025;
      g.rotation.z = Math.sin(t * 0.62 + item.phase) * 0.035;
    }
  });

  const lightsOn = night > LANTERN_LIGHT_THRESHOLD;
  return (
    <group>
      {items.map((item, k) => (
        <group
          key={item.i}
          ref={(g) => {
            refs.current[k] = g;
          }}
        >
          <primitive object={item.lantern} />
          {/* Stays mounted; only visible at night (see NIGHT_LIGHT). */}
          {k < EXTRA_LIT_LANTERNS && (
            <pointLight
              name={NIGHT_LIGHT}
              visible={lightsOn}
              color="#ffbd73"
              position={[0, 0.42, 0]}
              intensity={lightsOn ? 4.8 * night : 0}
              distance={3.8}
              decay={2}
            />
          )}
        </group>
      ))}
    </group>
  );
}

export function Houses({
  stars,
  highlight = -1,
  focused = null,
  night = 0,
  stargazers = null,
  interactive = true,
  onSelect,
  moving = false,
}: {
  stars: number;
  wind?: number;
  highlight?: number;
  focused?: number | null;
  night?: number;
  stargazers?: Stargazer[] | null;
  interactive?: boolean;
  onSelect?: (i: number) => void;
  moving?: boolean;
}) {
  const makeBuilding = useBuildingFactory();
  const { scene: lanternScene } = useGLTF(LANTERN);
  const anchors = useMemo(() => bonsaiAnchors(MAX_HOUSES), []);
  const baseY = useMemo(() => anchors.map((anchor) => anchor.pos.y + 0.35), [anchors]);

  const groups = useRef<(THREE.Group | null)[]>([]);
  const lastLoopCount = useRef(0);
  const frameSkip = useRef(0);
  const active = Math.min(anchors.length, Math.max(0, Math.floor(stars)));

  useFrame((state) => {
    if (moving) {
      frameSkip.current = (frameSkip.current + 1) % 2;
      if (frameSkip.current !== 0) return;
    } else {
      frameSkip.current = 0;
    }
    const t = state.clock.elapsedTime;
    const loopCount = Math.min(
      anchors.length,
      Math.max(active, lastLoopCount.current, highlight + 1),
    );
    let nextLoopCount = active;
    for (let i = 0; i < loopCount; i++) {
      const grp = groups.current[i];
      if (!grp) continue;
      const isHi = i === highlight;
      const target = i < active ? (isHi ? 1.15 : 1) : 0;
      grp.scale.x += (target - grp.scale.x) * 0.12;
      grp.scale.y = grp.scale.z = grp.scale.x;
      grp.visible = grp.scale.x > 0.01;
      // tiny settle bob in place (they're rooted to the branch, not floating)
      grp.position.y =
        baseY[i] + Math.sin(t * 0.8 + i) * (isHi ? 0.12 : 0.03);
      if (grp.visible || i < active) nextLoopCount = i + 1;
    }
    lastLoopCount.current = nextLoopCount;
  });

  return (
    <group>
      {anchors.map((a, i) => (
        <House
          key={i}
          i={i}
          anchor={a}
          tier={resolveTier(i, stargazers)}
          active={i < active}
          focused={focused === i}
          night={night}
          name={stargazers?.[i]?.login ?? nameForIndex(i)}
          contributor={Boolean(stargazers?.[i]?.contributor)}
          makeBuilding={makeBuilding}
          lanternScene={lanternScene}
          interactive={interactive}
          onSelect={onSelect}
          setRef={(idx, g) => {
            groups.current[idx] = g;
          }}
        />
      ))}
      <ExtraDeckLanterns
        anchors={anchors}
        active={active}
        night={night}
        stargazers={stargazers}
        lanternScene={lanternScene}
        moving={moving}
      />
    </group>
  );
}

useGLTF.preload(PACK);
useGLTF.preload(LANTERN);
