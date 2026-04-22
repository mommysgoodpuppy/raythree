import * as THREE from "three";

type IdMaps = {
  nodes: WeakMap<object, number>;
  geometries: WeakMap<object, number>;
  materials: WeakMap<object, number>;
  textures: WeakMap<object, number>;
};

export class StableIdRegistry {
  private nextId = 1;
  private readonly maps: IdMaps = {
    nodes: new WeakMap(),
    geometries: new WeakMap(),
    materials: new WeakMap(),
    textures: new WeakMap(),
  };

  getNodeId(object: THREE.Object3D): number {
    return this.getOrAssign(this.maps.nodes, object);
  }

  getGeometryId(geometry: THREE.BufferGeometry): number {
    return this.getOrAssign(this.maps.geometries, geometry);
  }

  getMaterialId(material: THREE.Material): number {
    return this.getOrAssign(this.maps.materials, material);
  }

  getTextureId(texture: THREE.Texture): number {
    return this.getOrAssign(this.maps.textures, texture);
  }

  private getOrAssign(map: WeakMap<object, number>, value: object): number {
    const existing = map.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const id = this.nextId++;
    map.set(value, id);
    return id;
  }
}
