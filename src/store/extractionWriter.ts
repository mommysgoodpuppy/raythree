/**
 * A polled writer: turns raythree's per-frame `ExtractionResult` into scene store writes.
 *
 * The store's write path compares before it marks, so calling this every frame with an
 * unchanged scene commits nothing. Placement is pluggable: by default every item hangs under the
 * world node with its world matrix (a flat scene); an embedder that knows its tracked spaces maps
 * items under them with node-local matrices instead (see PetPlay's `sceneStoreWriter.ts`).
 */
import type {
  AssetBatch,
  ExtractionResult,
  GeometryAsset,
  InstancedRenderInstance,
  LightFrame,
  MaterialAsset,
  RenderInstance,
  TextureAsset,
} from "../ir.ts";
import type {
  GeometryData,
  ItemState,
  LightData,
  Matrix4,
  MaterialModel,
  MaterialState,
  MeshItemData,
  NumericArray,
  RowId,
  TextureMeta,
} from "./schema.ts";
import { WORLD_NODE } from "./schema.ts";
import type { SceneStore } from "./store.ts";

export interface ItemPlacement {
  node: RowId;
  /** Node-local matrix (column-major, 16 elements). */
  matrix: ArrayLike<number>;
}

export interface ExtractionWriterOptions {
  /** Where an instance hangs. Default: the world node, with its world matrix. */
  place?: (instance: RenderInstance) => ItemPlacement;
  /** Extension values for an instance's mesh data (embedder flags). */
  extensions?: (instance: RenderInstance) => Record<string, unknown>;
}

export interface WriteStats {
  items: number;
  removedItems: number;
}

export class ExtractionStoreWriter {
  private readonly itemIds = new Map<string, RowId>();
  private nextItemId = 1;
  private readonly lightIds = new Set<RowId>();
  private readonly matrix = new Float64Array(16);

  constructor(
    private readonly store: SceneStore,
    private readonly options: ExtractionWriterOptions = {},
  ) {}

  /** Writes one extraction. Call inside an outer `store.transaction` to join other writers. */
  write(result: ExtractionResult): WriteStats {
    return this.store.transaction(() => {
      this.writeAssets(result.assets);
      this.writeLights(result.frame.lights);
      return this.writeItems(result.frame.instances);
    });
  }

  private writeAssets(assets: AssetBatch): void {
    // Assets first: items written below may refer to them.
    for (const texture of assets.textures) {
      this.store.write("textures", texture.id, {
        meta: textureMeta(texture),
        source: { uri: texture.source ?? null, mimeType: null, bytes: null },
      });
    }
    for (const geometry of assets.geometries) {
      this.store.write("geometries", geometry.id, { data: geometryData(geometry) });
    }
    for (const material of assets.materials) {
      this.store.write("materials", material.id, {
        model: materialModel(material),
        state: materialState(material),
      });
    }
  }

  private writeLights(lights: LightFrame[]): void {
    const seen = new Set<RowId>();
    for (const light of lights) {
      seen.add(light.id);
      this.lightIds.add(light.id);
      this.store.write("lights", light.id, {
        light: lightData(light),
        placement: { node: WORLD_NODE, matrix: lightMatrix(light) },
      });
    }
    for (const id of this.lightIds) {
      if (seen.has(id)) continue;
      this.store.remove("lights", id);
      this.lightIds.delete(id);
    }
  }

  private writeItems(instances: RenderInstance[]): WriteStats {
    const seen = new Set<string>();
    const perNode = new Map<number, number>();
    for (const instance of instances) {
      // One object can lower to several instances (multi-material); key them by position.
      const n = perNode.get(instance.nodeId) ?? 0;
      perNode.set(instance.nodeId, n + 1);
      const key = n === 0 ? `${instance.nodeId}` : `${instance.nodeId}:${n}`;
      seen.add(key);
      let id = this.itemIds.get(key);
      if (id === undefined) {
        id = this.nextItemId++;
        this.itemIds.set(key, id);
      }
      const placement = this.options.place?.(instance) ??
        { node: WORLD_NODE, matrix: instance.worldMatrix };
      this.matrix.set(placement.matrix as ArrayLike<number>);
      this.store.write("items", id, {
        header: { kind: instance.kind, node: placement.node },
        transform: this.matrix,
        state: itemState(instance),
        data: meshData(instance, this.options.extensions?.(instance) ?? {}),
      });
    }
    let removedItems = 0;
    for (const [key, id] of this.itemIds) {
      if (seen.has(key)) continue;
      this.store.remove("items", id);
      this.itemIds.delete(key);
      removedItems++;
    }
    return { items: instances.length, removedItems };
  }
}

function itemState(instance: RenderInstance): ItemState {
  return {
    visible: true,
    layerMask: instance.layerMask,
    order: instance.renderOrder,
    depthSorted: instance.transparent,
  };
}

function meshData(instance: RenderInstance, extensions: Record<string, unknown>): MeshItemData {
  const instanced = instance.kind === "instancedMesh"
    ? instance as InstancedRenderInstance
    : null;
  return {
    geometry: instance.geometryId,
    material: instance.materialId,
    castShadow: instance.castShadow,
    receiveShadow: instance.receiveShadow,
    overlay: instance.hudOverUi === true,
    instances: instanced ? instanced.instanceMatrices.subarray(0, instanced.instanceCount * 16) : null,
    instanceCount: instanced ? instanced.instanceCount : 0,
    extensions,
  };
}

function geometryData(geometry: GeometryAsset): GeometryData {
  const attributes: GeometryData["attributes"] = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    attributes[name] = {
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
      array: attribute.array as NumericArray,
    };
  }
  return {
    topology: geometry.topology,
    attributes,
    index: geometry.index?.array ?? null,
    bounds: geometry.bounds ?? null,
  };
}

const WRAP: Record<number, TextureMeta["wrapS"]> = { 1000: "repeat", 1001: "clamp", 1002: "mirror" };

function textureMeta(texture: TextureAsset): TextureMeta {
  return {
    width: texture.width,
    height: texture.height,
    format: texture.format,
    colorSpace: texture.colorSpace,
    flipY: texture.flipY,
    generateMipmaps: texture.generateMipmaps,
    wrapS: WRAP[texture.wrapS] ?? "clamp",
    wrapT: WRAP[texture.wrapT] ?? "clamp",
  };
}

function materialModel(material: MaterialAsset): MaterialModel {
  const custom = material.kind === "custom";
  const extensions: Record<string, unknown> = {};
  if (custom) extensions["raythree.custom"] = { label: material.debugLabel };
  if (Object.keys(material.uniforms).length) extensions["raythree.uniforms"] = material.uniforms;
  return {
    model: material.kind === "standard" ? "pbr" : custom ? "raythree.custom" : "unlit",
    fallback: material.kind === "standard" ? "pbr" : "unlit",
    baseColor: material.baseColor,
    emissive: material.emissiveColor ?? null,
    roughness: material.roughness ?? null,
    metalness: material.metalness ?? null,
    vertexColors: material.vertexColors === true,
    textures: material.textures.map((t) => ({ slot: t.slot, texture: t.textureId })),
    extensions,
  };
}

function materialState(material: MaterialAsset): MaterialState {
  const s = material.state;
  return {
    blend: s.blendMode,
    cull: s.cullMode,
    depthTest: s.depthTest,
    depthWrite: s.depthWrite,
    colorWrite: s.colorWrite,
    wireframe: s.wireframe,
  };
}

function lightData(light: LightFrame): LightData {
  return {
    type: light.type,
    color: light.color,
    intensity: light.intensity,
    range: light.distance ?? null,
    decay: light.decay ?? null,
    innerConeAngle: light.angle != null && light.penumbra != null
      ? light.angle * (1 - light.penumbra)
      : null,
    outerConeAngle: light.angle ?? null,
  };
}

/** Translation to the light's position, with -Z turned to its direction. */
function lightMatrix(light: LightFrame): Matrix4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  const [px, py, pz] = light.position ?? [0, 0, 0];
  m[12] = px;
  m[13] = py;
  m[14] = pz;
  if (light.direction) {
    // z axis = -direction; x and y complete a right-handed basis.
    let [zx, zy, zz] = light.direction.map((v) => -v) as [number, number, number];
    const len = Math.hypot(zx, zy, zz) || 1;
    zx /= len, zy /= len, zz /= len;
    const [ux, uy, uz] = Math.abs(zy) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl, xy /= xl, xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    m[0] = xx, m[1] = xy, m[2] = xz;
    m[4] = yx, m[5] = yy, m[6] = yz;
    m[8] = zx, m[9] = zy, m[10] = zz;
  }
  return m;
}
