import * as THREE from "three";

const baseUpdateMatrixWorld = THREE.Object3D.prototype.updateMatrixWorld;

/**
 * Object3D.updateMatrixWorld, minus invisible subtrees. three.js refreshes the
 * world matrix of every object each frame, hidden or not; most of the scene
 * graph is ~90 skinned ants, and a good share of them are hidden inside their
 * houses at any moment. Nothing hidden is drawn or casts a shadow, and a
 * subtree that becomes visible again is fully refreshed on that same frame
 * (its root's updateMatrix() flags it, which forces its descendants).
 *
 * Classes that extend updateMatrixWorld (SkinnedMesh keeps its bind matrix in
 * sync there, Camera its inverse) are handed to their own implementation.
 */
export function updateVisibleMatrixWorld(object: THREE.Object3D, force: boolean): void {
  if (!object.visible) return;
  if (object.updateMatrixWorld !== baseUpdateMatrixWorld) {
    object.updateMatrixWorld(force);
    return;
  }
  if (object.matrixAutoUpdate) object.updateMatrix();
  if (object.matrixWorldNeedsUpdate || force) {
    if (object.matrixWorldAutoUpdate) {
      if (object.parent === null) object.matrixWorld.copy(object.matrix);
      else object.matrixWorld.multiplyMatrices(object.parent.matrixWorld, object.matrix);
    }
    object.matrixWorldNeedsUpdate = false;
    force = true;
  }
  const children = object.children;
  for (let i = 0, n = children.length; i < n; i++) updateVisibleMatrixWorld(children[i], force);
}

/**
 * Bakes the current local transforms of a static, code-built subtree and stops
 * three.js from recomposing them every frame. Only for objects nothing moves
 * afterwards, and not for roots that receive transform props from React.
 */
export function freezeTransforms(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
}
