import * as THREE from "three";

import { StableIdRegistry } from "./ids.ts";
import type {
  AssetBatch,
  CameraFrame,
  ExtractionResult,
  ExtractionWarning,
  GeometryAsset,
  GeometryAttributeAsset,
  InstancedRenderInstance,
  LightFrame,
  MaterialAsset,
  RenderInstance,
  TextureAsset,
} from "./ir.ts";
import {
  createDefaultLowerers,
  type LoweringContext,
  type RenderLowerer,
} from "./lowerers.ts";

export interface BridgeUserData {
  kind?: "auto" | "skip";
}

export interface RaythreeExtractorOptions {
  lowerers?: RenderLowerer[];
}

export class RaythreeExtractor {
  private readonly ids = new StableIdRegistry();
  private readonly lowerers: RenderLowerer[];
  private readonly geometryRevisions = new WeakMap<THREE.BufferGeometry, number>();
  private readonly materialRevisions = new WeakMap<THREE.Material, number>();
  private readonly textureRevisions = new WeakMap<THREE.Texture, number>();

  constructor(options: RaythreeExtractorOptions = {}) {
    this.lowerers = options.lowerers ?? createDefaultLowerers();
  }

  extract(scene: THREE.Scene, camera: THREE.Camera): ExtractionResult {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      (camera as THREE.OrthographicCamera).updateProjectionMatrix();
    }

    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const assets: AssetBatch = {
      geometries: [],
      materials: [],
      textures: [],
    };
    const warnings: ExtractionWarning[] = [];

    const context: LoweringContext = {
      getNodeId: (object) => this.ids.getNodeId(object),
      ensureGeometry: (geometry) => this.ensureGeometry(geometry, assets),
      ensureMaterial: (material) => this.ensureMaterial(material, assets),
      warn: (warning) => warnings.push(warning),
    };

    const frame = {
      camera: this.extractCamera(camera),
      lights: [] as LightFrame[],
      instances: [] as Array<RenderInstance | InstancedRenderInstance>,
    };

    scene.traverseVisible((object: THREE.Object3D) => {
      const bridge = object.userData.bridge as BridgeUserData | undefined;
      if (bridge?.kind === "skip") {
        return;
      }

      if (object instanceof THREE.Light) {
        const light = this.extractLight(object);
        if (light !== null) {
          frame.lights.push(light);
        }
        return;
      }

      if (!(object instanceof THREE.Object3D)) {
        return;
      }

      const lowerer = this.lowerers.find((candidate) => candidate.canLower(object));
      if (lowerer === undefined) {
        if (this.shouldWarnForObject(object)) {
          warnings.push({
            nodeId: this.ids.getNodeId(object),
            objectName: object.name,
            objectType: object.type,
            reason: "No lowerer registered for this renderable object type.",
          });
        }
        return;
      }

      const lowered = lowerer.lower(object, context);
      frame.instances.push(...lowered);
    });

    frame.instances.sort((left, right) => {
      if (left.renderOrder !== right.renderOrder) {
        return left.renderOrder - right.renderOrder;
      }
      if (left.transparent !== right.transparent) {
        return Number(left.transparent) - Number(right.transparent);
      }
      return left.nodeId - right.nodeId;
    });

    return { assets, frame, warnings };
  }

  private ensureGeometry(geometry: THREE.BufferGeometry, assets: AssetBatch): number {
    const revision = this.getGeometryRevision(geometry);
    const previousRevision = this.geometryRevisions.get(geometry);
    const geometryId = this.ids.getGeometryId(geometry);

    if (previousRevision === revision) {
      return geometryId;
    }

    const attributes: Record<string, GeometryAttributeAsset> = {};
    const attributesRecord = geometry.attributes as Record<
      string,
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    >;
    for (const [name, attribute] of Object.entries(attributesRecord)) {
      if (!(attribute instanceof THREE.BufferAttribute)) {
        continue;
      }

      attributes[name] = {
        itemSize: attribute.itemSize,
        count: attribute.count,
        normalized: attribute.normalized,
        componentType: attribute.array.constructor.name,
        array: cloneNumericArray(attribute.array),
      };
    }

    let index: GeometryAsset["index"];
    if (geometry.index !== null) {
      index = {
        count: geometry.index.count,
        componentType: geometry.index.array.constructor.name,
        array: cloneIndexArray(geometry.index.array),
      };
    }

    const nextAsset: GeometryAsset = {
      id: geometryId,
      topology: "triangles",
      revision,
      attributes,
      index,
    };

    if (geometry.boundingSphere !== null || geometry.attributes.position !== undefined) {
      geometry.computeBoundingSphere();
      if (geometry.boundingSphere !== null) {
        nextAsset.bounds = {
          center: [
            geometry.boundingSphere.center.x,
            geometry.boundingSphere.center.y,
            geometry.boundingSphere.center.z,
          ],
          radius: geometry.boundingSphere.radius,
        };
      }
    }

    this.geometryRevisions.set(geometry, revision);
    assets.geometries.push(nextAsset);
    return geometryId;
  }

  private ensureMaterial(material: THREE.Material, assets: AssetBatch): MaterialAsset {
    const revision = this.getMaterialRevision(material);
    const materialId = this.ids.getMaterialId(material);

    const nextAsset = this.extractMaterial(material, materialId, revision, assets);
    if (this.materialRevisions.get(material) !== revision) {
      this.materialRevisions.set(material, revision);
      assets.materials.push(nextAsset);
    }
    return nextAsset;
  }

  private extractMaterial(
    material: THREE.Material,
    materialId: number,
    revision: number,
    assets: AssetBatch,
  ): MaterialAsset {
    const typedMaterial = material as THREE.Material & {
      color?: THREE.Color | number;
      emissive?: THREE.Color | number;
      opacity?: number;
      transparent?: boolean;
      depthWrite?: boolean;
      depthTest?: boolean;
      wireframe?: boolean;
      side?: number;
      blending?: number;
      roughness?: number;
      metalness?: number;
      map?: THREE.Texture | null;
      normalMap?: THREE.Texture | null;
      emissiveMap?: THREE.Texture | null;
      metalnessMap?: THREE.Texture | null;
      roughnessMap?: THREE.Texture | null;
    };

    const textures = [
      bindTexture("map", typedMaterial.map, assets, this.ids, this.textureRevisions),
      bindTexture("normalMap", typedMaterial.normalMap, assets, this.ids, this.textureRevisions),
      bindTexture("emissiveMap", typedMaterial.emissiveMap, assets, this.ids, this.textureRevisions),
      bindTexture("metalnessMap", typedMaterial.metalnessMap, assets, this.ids, this.textureRevisions),
      bindTexture("roughnessMap", typedMaterial.roughnessMap, assets, this.ids, this.textureRevisions),
    ].filter((value) => value !== null);

    return {
      id: materialId,
      revision,
      kind: classifyMaterial(material),
      baseColor: colorToTuple(typedMaterial.color, typedMaterial.opacity ?? material.opacity ?? 1),
      emissiveColor: typedMaterial.emissive !== undefined
        ? colorToTriplet(typedMaterial.emissive)
        : undefined,
      roughness: typedMaterial.roughness,
      metalness: typedMaterial.metalness,
      opacity: typedMaterial.opacity ?? material.opacity ?? 1,
      textures,
      uniforms: {
        toneMapped: material.toneMapped,
        fog: material.fog,
      },
      state: {
        transparent: typedMaterial.transparent ?? material.transparent,
        depthWrite: typedMaterial.depthWrite ?? material.depthWrite,
        depthTest: typedMaterial.depthTest ?? material.depthTest,
        cullMode: sideToCullMode(typedMaterial.side ?? material.side),
        blendMode: blendingToBlendMode(typedMaterial.blending ?? material.blending),
        wireframe: typedMaterial.wireframe ?? false,
      },
      debugLabel: material.type,
    };
  }

  private extractCamera(camera: THREE.Camera): CameraFrame {
    const position = new THREE.Vector3();
    camera.getWorldPosition(position);

    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspective = camera as THREE.PerspectiveCamera;
      return {
        type: "perspective",
        viewMatrix: new Float32Array(camera.matrixWorldInverse.elements),
        projectionMatrix: new Float32Array(camera.projectionMatrix.elements),
        worldMatrix: new Float32Array(camera.matrixWorld.elements),
        position: [position.x, position.y, position.z],
        near: perspective.near,
        far: perspective.far,
        fovYRadians: THREE.MathUtils.degToRad(perspective.fov),
        zoom: perspective.zoom,
      };
    }

    const orthographic = camera as THREE.OrthographicCamera;
    return {
      type: "orthographic",
      viewMatrix: new Float32Array(camera.matrixWorldInverse.elements),
      projectionMatrix: new Float32Array(camera.projectionMatrix.elements),
      worldMatrix: new Float32Array(camera.matrixWorld.elements),
      position: [position.x, position.y, position.z],
      near: orthographic.near,
      far: orthographic.far,
      zoom: orthographic.zoom,
    };
  }

  private extractLight(light: THREE.Light): LightFrame | null {
    const id = this.ids.getNodeId(light);
    const color = colorToTriplet(light.color as THREE.Color | number | undefined);
    const position = new THREE.Vector3();
    light.getWorldPosition(position);

    if (light instanceof THREE.AmbientLight) {
      return {
        id,
        type: "ambient",
        color,
        intensity: light.intensity,
      };
    }

    if (light instanceof THREE.DirectionalLight) {
      const target = new THREE.Vector3();
      light.target.getWorldPosition(target);
      const direction = target.sub(position).normalize();
      return {
        id,
        type: "directional",
        color,
        intensity: light.intensity,
        position: [position.x, position.y, position.z],
        direction: [direction.x, direction.y, direction.z],
      };
    }

    if (light instanceof THREE.PointLight) {
      return {
        id,
        type: "point",
        color,
        intensity: light.intensity,
        position: [position.x, position.y, position.z],
        distance: light.distance,
        decay: light.decay,
      };
    }

    if (light instanceof THREE.SpotLight) {
      const target = new THREE.Vector3();
      light.target.getWorldPosition(target);
      const direction = target.sub(position).normalize();
      return {
        id,
        type: "spot",
        color,
        intensity: light.intensity,
        position: [position.x, position.y, position.z],
        direction: [direction.x, direction.y, direction.z],
        distance: light.distance,
        decay: light.decay,
        angle: light.angle,
        penumbra: light.penumbra,
      };
    }

    return null;
  }

  private shouldWarnForObject(object: THREE.Object3D): boolean {
    return (
      object instanceof THREE.Line ||
      object instanceof THREE.LineSegments ||
      object instanceof THREE.Points ||
      object instanceof THREE.Sprite
    );
  }

  private getGeometryRevision(geometry: THREE.BufferGeometry): number {
    let revision = 0;
    const attributesRecord = geometry.attributes as Record<
      string,
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    >;
    for (const attribute of Object.values(attributesRecord)) {
      if (attribute instanceof THREE.BufferAttribute) {
        revision += attribute.version;
      }
    }
    revision += geometry.index?.version ?? 0;
    return revision;
  }

  private getMaterialRevision(material: THREE.Material): number {
    return material.version;
  }
}

function cloneNumericArray(array: ArrayLike<number>): GeometryAttributeAsset["array"] {
  if (array instanceof Float32Array) return array.slice();
  if (array instanceof Float64Array) return array.slice();
  if (array instanceof Int8Array) return array.slice();
  if (array instanceof Int16Array) return array.slice();
  if (array instanceof Int32Array) return array.slice();
  if (array instanceof Uint8Array) return array.slice();
  if (array instanceof Uint8ClampedArray) return array.slice();
  if (array instanceof Uint16Array) return array.slice();
  if (array instanceof Uint32Array) return array.slice();
  throw new Error(`Unsupported attribute array type: ${array.constructor.name}`);
}

function cloneIndexArray(array: ArrayLike<number>): Uint16Array | Uint32Array {
  if (array instanceof Uint16Array) return array.slice();
  if (array instanceof Uint32Array) return array.slice();
  throw new Error(`Unsupported index array type: ${array.constructor.name}`);
}

function bindTexture(
  slot: string,
  texture: THREE.Texture | null | undefined,
  assets: AssetBatch,
  ids: StableIdRegistry,
  revisions: WeakMap<THREE.Texture, number>,
) {
  if (texture === null || texture === undefined) {
    return null;
  }

  const textureId = ids.getTextureId(texture);
  const revision = texture.version;
  const previousRevision = revisions.get(texture);
  if (previousRevision !== revision) {
    assets.textures.push(extractTexture(texture, textureId, revision));
    revisions.set(texture, revision);
  }

  return {
    slot,
    textureId,
  };
}

function extractTexture(texture: THREE.Texture, id: number, revision: number): TextureAsset {
  const source = texture.source;
  const data = source.data as { width?: number; height?: number; currentSrc?: string; src?: string } | undefined;
  return {
    id,
    revision,
    width: data?.width ?? 0,
    height: data?.height ?? 0,
    flipY: texture.flipY,
    format: texture.format.toString(),
    colorSpace: texture.colorSpace,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    generateMipmaps: texture.generateMipmaps,
    source: data?.currentSrc ?? data?.src,
  };
}

function classifyMaterial(material: THREE.Material): MaterialAsset["kind"] {
  if (material instanceof THREE.MeshBasicMaterial) {
    return "unlit";
  }
  if (
    material instanceof THREE.MeshLambertMaterial ||
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial
  ) {
    return "standard";
  }
  return "custom";
}

function colorToTuple(
  color: THREE.Color | number | undefined,
  alpha: number,
): [number, number, number, number] {
  const [r, g, b] = colorToTriplet(color);
  return [r, g, b, alpha];
}

function colorToTriplet(
  color: THREE.Color | number | undefined,
): [number, number, number] {
  if (typeof color === "number") {
    const converted = new THREE.Color(color);
    return [converted.r, converted.g, converted.b];
  }

  if (color !== undefined) {
    return [color.r, color.g, color.b];
  }

  return [1, 1, 1];
}

function sideToCullMode(side: number): MaterialAsset["state"]["cullMode"] {
  if (side === THREE.DoubleSide) return "none";
  if (side === THREE.BackSide) return "front";
  return "back";
}

function blendingToBlendMode(blending: number): MaterialAsset["state"]["blendMode"] {
  if (blending === THREE.AdditiveBlending) return "add";
  if (blending === THREE.MultiplyBlending) return "multiply";
  if (blending === THREE.NormalBlending) return "alpha";
  return "opaque";
}
