import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";

import { RaythreeExtractor } from "../src/extract.ts";

const extractor = new RaythreeExtractor();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
camera.position.z = 3;

scene.add(
  new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicNodeMaterial({
      colorNode: TSL.color(0xff8b3d),
    }),
  ),
);

const standard = new THREE.Mesh(
  new THREE.SphereGeometry(0.5, 16, 16),
  new THREE.MeshStandardNodeMaterial({
    colorNode: TSL.color(0x54d62c),
  }),
);
standard.position.x = 1.5;
scene.add(standard);

const extraction = extractor.extract(scene, camera);

for (const material of extraction.assets.materials) {
  console.log(
    JSON.stringify({
      type: material.debugLabel,
      kind: material.kind,
      baseColor: material.baseColor.map((value) => Number(value.toFixed(6))),
    }),
  );
}
