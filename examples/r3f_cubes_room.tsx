import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";

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
const CUBE_COUNT = 200;

const extractor = new RaythreeExtractor();
const renderer = new RaylibRenderer({
  raylibPath: Deno.args[0] ?? DEFAULT_RAYLIB_PATH,
  width: WIDTH,
  height: HEIGHT,
  title: "raythree r3f cubes room",
  drawMode: "solid",
  debugLights: true,
});

const r3f = await createR3FExtractionRoot({
  width: WIDTH,
  height: HEIGHT,
  camera: { position: [0, 1.6, 3], fov: 50, near: 0.1, far: 10 },
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
  const cubes = React.useMemo(
    () => Array.from({ length: CUBE_COUNT }, () => createCubeSeed()),
    [],
  );
  const backgroundColor = React.useMemo(() => new THREE.Color(0x505050), []);
  const ambientColor = React.useMemo(() => new THREE.Color(0xa5a5a5), []);
  const roomLineColor = React.useMemo(() => new THREE.Color(0xbcbcbc), []);

  return (
    <>
      <SceneCamera />
      <color attach="background" args={[backgroundColor]} />
      <ambientLight color={ambientColor} intensity={1.2} />
      <pointLight position={[1.8, 4.8, 1.6]} intensity={10} distance={12} decay={2} />
      <RoomWireBox color={roomLineColor} />
      {cubes.map((seed, index) => (
        <BouncingCube key={index} seed={seed} />
      ))}
    </>
  );
}

function SceneCamera() {
  const camera = useThree((state) => state.camera);

  React.useLayoutEffect(() => {
    camera.position.set(0, 1.6, 3);
    camera.lookAt(0, 1.6, 0);
    camera.updateProjectionMatrix();
  }, [camera]);

  return null;
}

function RoomWireBox({ color }: { color: THREE.Color }) {
  const geometry = React.useMemo(
    () => new BoxLineGeometry(6, 6, 6, 10, 10, 10).translate(0, 3, 0),
    [],
  );

  React.useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

type CubeSeed = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  color: THREE.Color;
  velocity: [number, number, number];
};

function BouncingCube({ seed }: { seed: CubeSeed }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const velocity = React.useRef(new THREE.Vector3(...seed.velocity));

  useFrame((_state, deltaSeconds) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }

    const delta = deltaSeconds * 60;
    velocity.current.multiplyScalar(1 - (0.001 * delta));
    mesh.position.addScaledVector(velocity.current, delta);

    if (mesh.position.x < -3 || mesh.position.x > 3) {
      mesh.position.x = THREE.MathUtils.clamp(mesh.position.x, -3, 3);
      velocity.current.x = -velocity.current.x;
    }

    if (mesh.position.y < 0 || mesh.position.y > 6) {
      mesh.position.y = THREE.MathUtils.clamp(mesh.position.y, 0, 6);
      velocity.current.y = -velocity.current.y;
    }

    if (mesh.position.z < -3 || mesh.position.z > 3) {
      mesh.position.z = THREE.MathUtils.clamp(mesh.position.z, -3, 3);
      velocity.current.z = -velocity.current.z;
    }

    mesh.rotation.x += velocity.current.x * 2 * delta;
    mesh.rotation.y += velocity.current.y * 2 * delta;
    mesh.rotation.z += velocity.current.z * 2 * delta;
  });

  return (
    <mesh
      ref={meshRef}
      position={seed.position}
      rotation={seed.rotation}
      scale={seed.scale}
    >
      <boxGeometry args={[0.15, 0.15, 0.15]} />
      <meshLambertMaterial color={seed.color} />
    </mesh>
  );
}

function createCubeSeed(): CubeSeed {
  return {
    position: [
      Math.random() * 4 - 2,
      Math.random() * 4,
      Math.random() * 4 - 2,
    ],
    rotation: [
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ],
    scale: [
      Math.random() + 0.5,
      Math.random() + 0.5,
      Math.random() + 0.5,
    ],
    color: new THREE.Color(Math.random() * 0xffffff),
    velocity: [
      Math.random() * 0.01 - 0.005,
      Math.random() * 0.01 - 0.005,
      Math.random() * 0.01 - 0.005,
    ],
  };
}
