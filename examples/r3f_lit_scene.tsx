import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { TeapotGeometry } from "three/addons/geometries/TeapotGeometry.js";

import {
  createR3FExtractionRoot,
  RaylibRenderer,
  RaythreeExtractor,
} from "../src/mod.ts";

const DEFAULT_RAYLIB_PATH = new URL(
  "../raylib-5.5_macos/lib/libraylib.dylib",
  import.meta.url,
).pathname;

const WIDTH = 1280;
const HEIGHT = 720;

const extractor = new RaythreeExtractor();
const renderer = new RaylibRenderer({
  raylibPath: Deno.args[0] ?? DEFAULT_RAYLIB_PATH,
  width: WIDTH,
  height: HEIGHT,
  title: "raythree r3f lit scene",
  drawMode: "solid",
  debugLights: true,
});

const r3f = await createR3FExtractionRoot({
  width: WIDTH,
  height: HEIGHT,
  camera: { position: [4.5, 3.2, 5.5], fov: 60, near: 0.1, far: 100 },
});

r3f.render(<App />);

try {
  while (!renderer.shouldClose()) {
    const scene = r3f.getScene();
    const camera = r3f.getCamera();
    if (scene !== null && camera !== null) {
      renderer.renderExtraction(extractor.extract(scene, camera));
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
} finally {
  r3f.dispose();
  renderer.dispose();
}

function App() {
  const backgroundColor = React.useMemo(() => new THREE.Color(0x0f172a), []);
  const ambientColor = React.useMemo(() => new THREE.Color(0xffffff), []);
  const pointColor = React.useMemo(() => new THREE.Color(0xffffff), []);
  const groundColor = React.useMemo(() => new THREE.Color(0x64748b), []);
  const cubeColor = React.useMemo(() => new THREE.Color(0x38bdf8), []);

  return (
    <>
      <SceneCameraAim />
      <color attach="background" args={[backgroundColor]} />
      <ambientLight color={ambientColor} intensity={0.16} />
      <pointLight color={pointColor} position={[2.2, 4.4, 1.6]} intensity={16} distance={12} decay={2} />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[12, 12]} />
        <meshStandardMaterial color={groundColor} roughness={0.95} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.8, 0]} rotation={[0.18, 0.45, 0]} castShadow>
        <boxGeometry args={[1.6, 1.6, 1.6]} />
        <meshStandardMaterial color={cubeColor} roughness={0.32} metalness={0.15} />
      </mesh>
      <TeapotMesh />
    </>
  );
}

function SceneCameraAim() {
  const camera = useThree((state) => state.camera);

  React.useLayoutEffect(() => {
    camera.position.set(4.5, 3.2, 5.5);
    camera.lookAt(0, 0.8, 0);
    camera.updateProjectionMatrix();
  }, [camera]);

  return null;
}

function TeapotMesh() {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const geometry = React.useMemo(
    () => new TeapotGeometry(0.85, 10, true, true, true, false, true),
    [],
  );
  const teapotColor = React.useMemo(() => new THREE.Color(0xf59e0b), []);

  useFrame((state) => {
    if (meshRef.current !== null) {
      meshRef.current.rotation.y = -0.6 + Math.sin(state.clock.elapsedTime * 0.5) * 0.08;
    }
  });

  React.useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <mesh ref={meshRef} geometry={geometry} position={[-2.1, 0.72, 0.35]} castShadow>
      <meshStandardMaterial color={teapotColor} roughness={0.45} metalness={0.1} />
    </mesh>
  );
}
