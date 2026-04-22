import * as THREE from "three";
import { BoxLineGeometry } from "three/addons/geometries/BoxLineGeometry.js";

import { RaylibRenderer, RaythreeExtractor } from "../src/mod.ts";

const DEFAULT_RAYLIB_PATH = new URL(
  "../raylib-5.5_macos/lib/libraylib.dylib",
  import.meta.url,
).pathname;

const extractor = new RaythreeExtractor();
const renderer = new RaylibRenderer({
  raylibPath: Deno.args[0] ?? DEFAULT_RAYLIB_PATH,
  width: 1280,
  height: 720,
  title: "raythree cubes room",
  drawMode: "solid",
  debugLights: true,
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x505050);

const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 10);
camera.position.set(0, 1.6, 3);
scene.add(camera);

const room = new THREE.LineSegments(
  new BoxLineGeometry(6, 6, 6, 10, 10, 10).translate(0, 3, 0),
  new THREE.LineBasicMaterial({ color: 0xbcbcbc }),
);
scene.add(room);

scene.add(new THREE.AmbientLight(0xa5a5a5, 1.2));

const light = new THREE.PointLight(0xffffff, 10, 12, 2);
light.position.set(1.8, 4.8, 1.6);
scene.add(light);

const cubeGeometry = new THREE.BoxGeometry(0.15, 0.15, 0.15);

for (let index = 0; index < 200; index++) {
  const object = new THREE.Mesh(
    cubeGeometry,
    new THREE.MeshLambertMaterial({ color: Math.random() * 0xffffff }),
  );

  object.position.x = Math.random() * 4 - 2;
  object.position.y = Math.random() * 4;
  object.position.z = Math.random() * 4 - 2;

  object.rotation.x = Math.random() * Math.PI * 2;
  object.rotation.y = Math.random() * Math.PI * 2;
  object.rotation.z = Math.random() * Math.PI * 2;

  object.scale.x = Math.random() + 0.5;
  object.scale.y = Math.random() + 0.5;
  object.scale.z = Math.random() + 0.5;

  object.userData.velocity = new THREE.Vector3(
    Math.random() * 0.01 - 0.005,
    Math.random() * 0.01 - 0.005,
    Math.random() * 0.01 - 0.005,
  );

  room.add(object);
}

let lastTime = performance.now();

try {
  while (!renderer.shouldClose()) {
    const now = performance.now();
    const delta = ((now - lastTime) / 1000) * 60;
    lastTime = now;

    for (let index = 0; index < room.children.length; index++) {
      const cube = room.children[index] as THREE.Mesh & {
        userData: { velocity: THREE.Vector3 };
      };

      cube.userData.velocity.multiplyScalar(1 - (0.001 * delta));
      cube.position.addScaledVector(cube.userData.velocity, delta);

      if (cube.position.x < -3 || cube.position.x > 3) {
        cube.position.x = THREE.MathUtils.clamp(cube.position.x, -3, 3);
        cube.userData.velocity.x = -cube.userData.velocity.x;
      }

      if (cube.position.y < 0 || cube.position.y > 6) {
        cube.position.y = THREE.MathUtils.clamp(cube.position.y, 0, 6);
        cube.userData.velocity.y = -cube.userData.velocity.y;
      }

      if (cube.position.z < -3 || cube.position.z > 3) {
        cube.position.z = THREE.MathUtils.clamp(cube.position.z, -3, 3);
        cube.userData.velocity.z = -cube.userData.velocity.z;
      }

      cube.rotation.x += cube.userData.velocity.x * 2 * delta;
      cube.rotation.y += cube.userData.velocity.y * 2 * delta;
      cube.rotation.z += cube.userData.velocity.z * 2 * delta;
    }

    renderer.renderExtraction(extractor.extract(scene, camera));
  }
} finally {
  renderer.dispose();
}
