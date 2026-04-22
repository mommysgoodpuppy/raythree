import * as THREE from "three";
import { TeapotGeometry } from "three/addons/geometries/TeapotGeometry.js";

import { RaylibRenderer, RaythreeExtractor } from "./src/mod.ts";

const DEFAULT_RAYLIB_PATH = new URL(
  "./raylib-5.5_macos/lib/libraylib.dylib",
  import.meta.url,
).pathname;

const extractor = new RaythreeExtractor();
const renderer = new RaylibRenderer({
  raylibPath: Deno.args[0] ?? DEFAULT_RAYLIB_PATH,
  width: 1280,
  height: 720,
  title: "raythree lit point light",
  drawMode: "solid",
  debugLights: true,
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);

const camera = new THREE.PerspectiveCamera(60, 1280 / 720, 0.1, 100);
camera.position.set(4.5, 3.2, 5.5);
camera.lookAt(0, 0.8, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.16));

const pointLight = new THREE.PointLight(0xffffff, 16, 12, 2);
pointLight.position.set(2.2, 4.4, 1.6);
scene.add(pointLight);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x64748b),
    roughness: 0.95,
    metalness: 0.05,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 1.6, 1.6),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x38bdf8),
    roughness: 0.32,
    metalness: 0.15,
  }),
);
cube.position.set(0, 0.8, 0);
cube.castShadow = true;
cube.rotation.set(0.18, 0.45, 0);
scene.add(cube);

const teapot = new THREE.Mesh(
  new TeapotGeometry(0.85, 10, true, true, true, false, true),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf59e0b),
    roughness: 0.45,
    metalness: 0.1,
  }),
);
teapot.position.set(-2.1, 0.72, 0.35);
teapot.rotation.set(0, -0.6, 0);
teapot.castShadow = true;
scene.add(teapot);

try {
  while (!renderer.shouldClose()) {
    renderer.renderExtraction(extractor.extract(scene, camera));
  }
} finally {
  renderer.dispose();
}
