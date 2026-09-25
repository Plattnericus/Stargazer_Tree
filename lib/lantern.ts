import * as THREE from "three";
import { freezeTransforms } from "./matrixUpdates";

// One uniform lantern size everywhere (decks + bridges) so they all match.
export const LANTERN_SIZE = 1.45;

// Lantern point lights are only switched on (visible) while it's dark. Every
// lit material evaluates every visible point light per pixel, even at
// intensity 0, so leaving them on all day was pure waste. Flipping them changes
// the shader variant of each lit material; Experience precompiles the other
// variant by this name so dusk and dawn don't freeze.
export const NIGHT_LIGHT = "night-light";

/** Night factor above which the lanterns cast real light. */
export const LANTERN_LIGHT_THRESHOLD = 0.04;

// Glowing lantern materials, shared by every lantern of the same glow group.
// Lanterns in a group always glow alike (setLanternGlow is driven by the same
// night factor for all of them), and a separate material per lantern part
// made three re-upload every material uniform, all lantern point lights
// included, before each of ~65 lantern draws. Shared, they draw back to back.
const glowMaterials = new Map<string, Map<THREE.Material, THREE.MeshStandardMaterial>>();

function lanternMaterial(source: THREE.Material, group: string, emissive: number) {
  let bySource = glowMaterials.get(group);
  if (!bySource) glowMaterials.set(group, (bySource = new Map()));
  let m = bySource.get(source);
  if (!m) {
    m = (source as THREE.MeshStandardMaterial).clone();
    m.emissive = new THREE.Color("#ffb14d");
    m.emissiveIntensity = emissive;
    bySource.set(source, m);
  }
  return m;
}

// Clone the lantern model, make it glow warmly (emissive), and normalize it to
// `target` (by its largest dimension) with the base at y=0. `rotX` lets callers
// correct the model's up-axis. Lanterns built with the same `group` share
// their materials, so they must share their glow too (see setLanternGlow).
export function buildLantern(
  scene: THREE.Object3D,
  target = 0.7,
  rotX = 0,
  emissive = 1.6,
  group = "default",
): THREE.Group {
  const inner = scene.clone(true);
  inner.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = lanternMaterial(o.material as THREE.Material, group, emissive);
      o.castShadow = true;
    }
  });
  if (rotX) inner.rotation.x = rotX;
  inner.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const g = new THREE.Group();
  g.add(inner);
  g.scale.setScalar(target / (Math.max(size.x, size.y, size.z) || 1));
  inner.position.set(-center.x, -box.min.y, -center.z);
  // Lanterns only sway through their parent groups; their own nodes are static.
  freezeTransforms(g);
  return g;
}

/**
 * Update a built lantern's glow WITHOUT rebuilding it. Rebuilding clones the
 * whole model + materials (heavy, GC churn) — day/night changes must only
 * touch emissiveIntensity. The materials are shared per glow group, so this
 * sets the glow of every lantern in the lantern's group.
 */
export function setLanternGlow(lantern: THREE.Object3D, intensity: number): void {
  lantern.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material as THREE.MeshStandardMaterial;
      if (m?.emissive) m.emissiveIntensity = intensity;
    }
  });
}
