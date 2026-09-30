"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import * as THREE from "three";

const MODEL = "/models/church-boden.glb";
export type ChurchJourney = {
  progress: number;
  reducedMotion: boolean;
  invalidate?: () => void;
};
type Props = {
  journey: MutableRefObject<ChurchJourney>;
  onReady: () => void;
  onError: () => void;
};

class SceneBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    useGLTF.clear(MODEL);
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
function Church({ onReady }: { onReady: () => void }) {
  const { scene } = useGLTF(MODEL, "/draco/");
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      // The scan already contains the real church's light. Preserve it
      // instead of applying synthetic lights over the baked texture.
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      const unlit = materials.map(
        (material) =>
          new THREE.MeshBasicMaterial({
            map: (material as THREE.MeshStandardMaterial).map,
            color: "#f3f0e9",
            side: THREE.DoubleSide,
          }),
      );
      object.material = Array.isArray(object.material) ? unlit : unlit[0];
    });
    return copy;
  }, [scene]);
  useEffect(() => {
    onReady();
    return () => {
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        materials.forEach((material) => material.dispose());
      });
    };
  }, [model, onReady]);
  return <primitive object={model} dispose={null} />;
}
function CameraJourney({ journey }: Pick<Props, "journey">) {
  const { camera, size, invalidate } = useThree();
  const lastAspect = useRef(0);
  const paths = useMemo(
    () => ({
      // Measured world coordinates: stay in the middle aisle, at eye level,
      // and stop before the altar steps.
      position: new THREE.CatmullRomCurve3([
        new THREE.Vector3(-4.6, 1.52, 0.12),
        new THREE.Vector3(-3.3, 1.54, 0.12),
        new THREE.Vector3(-1.75, 1.56, 0.1),
        new THREE.Vector3(-0.1, 1.57, 0.12),
        new THREE.Vector3(1.1, 1.6, 0.12),
      ]),
      target: new THREE.CatmullRomCurve3([
        new THREE.Vector3(4.5, 2.08, 0.12),
        new THREE.Vector3(4.5, 2.25, -0.15),
        new THREE.Vector3(4.4, 2.3, -0.45),
        new THREE.Vector3(4.5, 2.06, -0.05),
        new THREE.Vector3(4.5, 1.98, 0.12),
      ]),
      eye: new THREE.Vector3(),
      look: new THREE.Vector3(),
    }),
    [],
  );
  useEffect(() => {
    journey.current.invalidate = invalidate;
    invalidate();
    return () => {
      delete journey.current.invalidate;
    };
  }, [invalidate, journey]);
  useFrame(() => {
    const current = journey.current;
    // Reduced motion keeps a stable wide view while the text still scrolls.
    const progress = current.reducedMotion ? 0.28 : current.progress;
    paths.position.getPoint(progress, paths.eye);
    paths.target.getPoint(progress, paths.look);
    camera.position.copy(paths.eye);
    camera.lookAt(paths.look);
    const aspect = size.width / size.height;
    if (
      camera instanceof THREE.PerspectiveCamera &&
      lastAspect.current !== aspect
    ) {
      camera.fov = aspect < 0.8 ? 76 : 64;
      camera.updateProjectionMatrix();
      lastAspect.current = aspect;
    }
  });
  return null;
}
export default function MemorialChurch({ journey, onReady, onError }: Props) {
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    // Cap the scan's drawing buffer on large Retina screens. Type remains
    // native DOM text; rendering a 1024px scan texture at 5K adds little detail.
    const update = () =>
      setDpr(
        Math.max(
          0.75,
          Math.min(
            window.devicePixelRatio || 1,
            1.75,
            Math.sqrt(2_600_000 / (window.innerWidth * window.innerHeight)),
          ),
        ),
      );
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return (
    <SceneBoundary onError={onError}>
      <Canvas
        frameloop="demand"
        dpr={dpr}
        camera={{ position: [-4.6, 1.52, 0.12], fov: 64, near: 0.035, far: 35 }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: "high-performance",
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1,
        }}
        onCreated={({ gl }) => {
          gl.setClearColor("#171510");
        }}
      >
        <CameraJourney journey={journey} />
        <Suspense fallback={null}>
          <Church onReady={onReady} />
        </Suspense>
      </Canvas>
    </SceneBoundary>
  );
}
