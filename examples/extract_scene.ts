import * as THREE from "three";

import { RaythreeExtractor } from "../src/mod.ts";

const extractor = new RaythreeExtractor();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
camera.position.set(3, 2, 6);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.2));

const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(4, 6, 3);
sun.target.position.set(0, 0, 0);
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(8, 0.1, 8),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x334155),
    roughness: 0.95,
    metalness: 0.05,
  }),
);
ground.position.y = -1;
ground.receiveShadow = true;
ground.name = "ground";
scene.add(ground);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x3b82f6),
    roughness: 0.35,
    metalness: 0.2,
  }),
);
cube.position.set(-1.2, 0, 0);
cube.rotation.set(0.25, 0.6, 0);
cube.castShadow = true;
cube.name = "hero-cube";
scene.add(cube);

const instances = new THREE.InstancedMesh(
  new THREE.SphereGeometry(0.3, 16, 12),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf97316) }),
  3,
);
instances.name = "marker-cloud";
for (let index = 0; index < instances.count; index++) {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(index * 0.8 - 0.8, 0.6, -1.5),
    new THREE.Quaternion(),
    new THREE.Vector3(1, 1, 1),
  );
  instances.setMatrixAt(index, matrix);
}
scene.add(instances);

const skippedHelper = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.1, 1.1, 1.1)),
  new THREE.LineBasicMaterial({ color: 0xffffff }),
);
skippedHelper.position.copy(cube.position);
skippedHelper.userData.bridge = { kind: "skip" };
scene.add(skippedHelper);

const result = extractor.extract(scene, camera);

console.log(
  JSON.stringify(
    {
      assetCounts: {
        geometries: result.assets.geometries.length,
        materials: result.assets.materials.length,
        textures: result.assets.textures.length,
      },
      lightCount: result.frame.lights.length,
      instanceKinds: result.frame.instances.map((instance) => instance.kind),
      warnings: result.warnings,
      firstInstance: result.frame.instances[0] === undefined
        ? null
        : {
          kind: result.frame.instances[0].kind,
          nodeId: result.frame.instances[0].nodeId,
          geometryId: result.frame.instances[0].geometryId,
          materialId: result.frame.instances[0].materialId,
        },
    },
    null,
    2,
  ),
);
