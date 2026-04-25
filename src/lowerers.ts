import * as THREE from "three";
import type { InstancedBufferAttribute } from "three";
import { isInstancedPanelMeshRegisteredForRaythreeMeshLowerer } from "../../threewebxrwebgpudeno/local-uikit/raylibUikitMeshLowererRegistry.ts";

import type {
  ExtractionWarning,
  InstancedRenderInstance,
  MaterialAsset,
  RenderInstance,
} from "./ir.ts";

export interface LoweringContext {
  getNodeId(object: THREE.Object3D): number;
  ensureGeometry(geometry: THREE.BufferGeometry): number;
  ensureMaterial(material: THREE.Material): MaterialAsset;
  warn(warning: ExtractionWarning): void;
}

export interface RenderLowerer {
  canLower(object: THREE.Object3D): boolean;
  lower(
    object: THREE.Object3D,
    context: LoweringContext,
  ): Array<RenderInstance | InstancedRenderInstance>;
}

export function createDefaultLowerers(): RenderLowerer[] {
  return [new LineTubeLowerer(), new MeshLowerer()];
}

/** True when `instanceof` may not match (e.g. webgpu vs core bundle) but the object is still a mesh. */
function isMeshLike(object: THREE.Object3D): boolean {
  if (object instanceof THREE.Mesh) {
    return true;
  }
  const type = object.type;
  return type === "Mesh" || type === "InstancedMesh";
}

type GeometryAttributes = Record<
  string,
  THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
>;

/**
 * `Component` / `Container` (local-uikit) extend `THREE.Mesh` as flex **layout shells** with
 * `panelGeometry` — they are not world meshes for the Raythree IR. Skipping by duck-type avoids
 * importing uikit into raythree. `InstancedPanelMesh` has no `properties` / `node` fields; it is
 * covered by the WeakSet from `InstancedPanelGroup` or the attribute heuristics below.
 */
function isUikitComponentLayoutMesh(mesh: THREE.Mesh): boolean {
  const m = mesh as unknown as {
    properties?: unknown;
    node?: unknown;
    root?: { value?: { panelGroupManager?: unknown } };
  };
  if (m.properties == null || m.node == null || m.root == null) {
    return false;
  }
  return m.root.value != null && m.root.value.panelGroupManager != null;
}

/**
 * Uikit: WebGPU path draws `InstancedPanelMesh` + TSL, Raylib replicates from the same buffers.
 * The generic mesh lowerer must not also emit those objects as `kind: "mesh"`.
 */
function isDrawnByRaythreeUiSnapshot(mesh: THREE.Mesh): boolean {
  if (isUikitComponentLayoutMesh(mesh)) {
    return true;
  }
  if (isInstancedPanelMeshRegisteredForRaythreeMeshLowerer(mesh)) {
    return true;
  }
  const userData = mesh.userData as { raythreeUiText?: unknown } | undefined;
  if (userData?.raythreeUiText != null) {
    return true;
  }
  const ctor = (mesh as unknown as { constructor?: { name?: string } }).constructor;
  if (ctor?.name === "InstancedPanelMesh") {
    // petplay uikit: never lower; instanced aData is on this mesh, not on THREE.InstancedMesh
    return true;
  }
  const geometry = mesh.geometry;
  if (geometry == null) {
    return false;
  }
  const attrs = geometry.attributes as GeometryAttributes;
  const instanceMatrix =
    attrs.instanceMatrix != null
      ? attrs.instanceMatrix
      : (mesh as unknown as { instanceMatrix?: InstancedBufferAttribute | undefined })
        .instanceMatrix;
  if (instanceMatrix == null) {
    return false;
  }
  if (attrs.aData0 != null) {
    return true;
  }
  if (attrs.aData != null) {
    return true;
  }
  if (attrs.instanceRGBA != null) {
    return true;
  }
  return false;
}

/** True for line / line segments / line loop across duplicate Three module instances. */
function isLineLike(object: THREE.Object3D): boolean {
  if (object instanceof THREE.Line) {
    return true;
  }
  const type = object.type;
  return type === "Line" || type === "LineSegments" || type === "LineLoop";
}

class MeshLowerer implements RenderLowerer {
  canLower(object: THREE.Object3D): boolean {
    if (!isMeshLike(object)) {
      return false;
    }
    return !isDrawnByRaythreeUiSnapshot(object as unknown as THREE.Mesh);
  }

  lower(
    object: THREE.Object3D,
    context: LoweringContext,
  ): Array<RenderInstance | InstancedRenderInstance> {
    const mesh = object as unknown as THREE.Mesh;
    if (!Array.isArray(mesh.material)) {
      return [this.lowerSingleMaterialMesh(mesh, mesh.material, context)];
    }

    const primaryMaterial = mesh.material[0];
    if (primaryMaterial === undefined) {
      context.warn({
        nodeId: context.getNodeId(mesh as unknown as THREE.Object3D),
        objectName: mesh.name,
        objectType: mesh.type,
        reason: "Mesh has no material bindings.",
      });
      return [];
    }

    context.warn({
      nodeId: context.getNodeId(mesh as unknown as THREE.Object3D),
      objectName: mesh.name,
      objectType: mesh.type,
      reason: "Multi-material meshes currently use only the first material.",
    });
    return [this.lowerSingleMaterialMesh(mesh, primaryMaterial, context)];
  }

  private lowerSingleMaterialMesh(
    mesh: THREE.Mesh,
    material: THREE.Material,
    context: LoweringContext,
  ): RenderInstance | InstancedRenderInstance {
    const nodeId = context.getNodeId(mesh as unknown as THREE.Object3D);
    const materialAsset = context.ensureMaterial(material);
    const geometryId = context.ensureGeometry(mesh.geometry);
    const worldMatrix = new Float32Array(mesh.matrixWorld.elements);
    const normalMatrix3 = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const normalMatrix = new Float32Array(normalMatrix3.toArray());

    const hudOverUi = readRaythreeHudOverUi(mesh);

    if (mesh instanceof THREE.InstancedMesh || mesh.type === "InstancedMesh") {
      const instanced = mesh as unknown as THREE.InstancedMesh;
      const instanceMatrices = new Float32Array(instanced.count * 16);
      const instanceMatrix = new THREE.Matrix4();

      for (let index = 0; index < instanced.count; index++) {
        instanced.getMatrixAt(index, instanceMatrix);
        instanceMatrices.set(instanceMatrix.elements, index * 16);
      }

      return {
        kind: "instancedMesh",
        nodeId,
        geometryId,
        materialId: materialAsset.id,
        worldMatrix,
        normalMatrix,
        renderOrder: mesh.renderOrder,
        layerMask: mesh.layers.mask,
        transparent: materialAsset.state.transparent,
        receiveShadow: mesh.receiveShadow,
        castShadow: mesh.castShadow,
        instanceMatrices,
        instanceCount: instanced.count,
        ...(hudOverUi ? { hudOverUi: true } : {}),
      };
    }

    return {
      kind: "mesh",
      nodeId,
      geometryId,
      materialId: materialAsset.id,
      worldMatrix,
      normalMatrix,
      renderOrder: mesh.renderOrder,
      layerMask: mesh.layers.mask,
      transparent: materialAsset.state.transparent,
      receiveShadow: mesh.receiveShadow,
      castShadow: mesh.castShadow,
      ...(hudOverUi ? { hudOverUi: true } : {}),
    };
  }
}

type LineBridgeConfig = {
  kind?: "auto" | "skip";
  radius?: number;
  radialSegments?: number;
};

class LineTubeLowerer implements RenderLowerer {
  private readonly generatedGeometry = new WeakMap<
    THREE.Line,
    { signature: string; geometry: THREE.BufferGeometry }
  >();

  canLower(object: THREE.Object3D): boolean {
    return isLineLike(object);
  }

  lower(
    object: THREE.Object3D,
    context: LoweringContext,
  ): Array<RenderInstance | InstancedRenderInstance> {
    const line = object as unknown as THREE.Line;
    const material = pickPrimaryMaterial(line.material);
    if (material === null) {
      context.warn({
        nodeId: context.getNodeId(line as unknown as THREE.Object3D),
        objectName: line.name,
        objectType: line.type,
        reason: "Line has no material bindings.",
      });
      return [];
    }

    const geometry = this.getOrCreateGeometry(line, context);
    if (geometry === null) {
      return [];
    }

    const materialAsset = context.ensureMaterial(material);
    return [createRenderInstance(line, geometry, materialAsset, context)];
  }

  private getOrCreateGeometry(
    line: THREE.Line,
    context: LoweringContext,
  ): THREE.BufferGeometry | null {
    const bridge = ((line.userData as Record<string, unknown>).bridge ?? {}) as LineBridgeConfig;
    const radius = bridge.radius ?? 0.035;
    const radialSegments = bridge.radialSegments ?? 8;
    const version = getLineGeometryVersion(line.geometry);
    const signature = `${version}:${radius}:${radialSegments}:${line.type}`;
    const cached = this.generatedGeometry.get(line);
    if (cached?.signature === signature) {
      return cached.geometry;
    }

    const generated = buildTubeSegmentsGeometry(line, radius, radialSegments, context);
    if (generated === null) {
      return null;
    }

    this.generatedGeometry.set(line, { signature, geometry: generated });
    return generated;
  }
}

function createRenderInstance(
  object: THREE.Mesh | THREE.Line,
  geometry: THREE.BufferGeometry,
  materialAsset: MaterialAsset,
  context: LoweringContext,
): RenderInstance {
  const nodeId = context.getNodeId(object as unknown as THREE.Object3D);
  const geometryId = context.ensureGeometry(geometry);
  const worldMatrix = new Float32Array(object.matrixWorld.elements);
  const normalMatrix3 = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
  const normalMatrix = new Float32Array(normalMatrix3.toArray());

  const hudOverUi = readRaythreeHudOverUi(object);

  return {
    kind: "mesh",
    nodeId,
    geometryId,
    materialId: materialAsset.id,
    worldMatrix,
    normalMatrix,
    renderOrder: object.renderOrder,
    layerMask: object.layers.mask,
    transparent: materialAsset.state.transparent,
    receiveShadow: "receiveShadow" in object ? Boolean(object.receiveShadow) : false,
    castShadow: "castShadow" in object ? Boolean(object.castShadow) : false,
    ...(hudOverUi ? { hudOverUi: true } : {}),
  };
}

function readRaythreeHudOverUi(object: { userData: unknown }): boolean {
  return Boolean((object.userData as { raythreeHudOverUi?: boolean }).raythreeHudOverUi);
}

function pickPrimaryMaterial(
  material: THREE.Material | THREE.Material[],
): THREE.Material | null {
  if (!Array.isArray(material)) {
    return material;
  }
  return material[0] ?? null;
}

function getLineGeometryVersion(geometry: THREE.BufferGeometry): number {
  let revision = geometry.index?.version ?? 0;
  const attributes = geometry.attributes as Record<
    string,
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  >;
  for (const attribute of Object.values(attributes)) {
    revision += "version" in attribute ? attribute.version : 0;
  }
  return revision;
}

function buildTubeSegmentsGeometry(
  line: THREE.Line,
  radius: number,
  radialSegments: number,
  context: LoweringContext,
): THREE.BufferGeometry | null {
  const position = line.geometry.getAttribute("position");
  if (position == null || position.itemSize < 3) {
    context.warn({
      nodeId: context.getNodeId(line as unknown as THREE.Object3D),
      objectName: line.name,
      objectType: line.type,
      reason: "Line lowering requires a position attribute with 3 components.",
    });
    return null;
  }

  const segments = collectLineSegments(
    line,
    position as unknown as THREE.BufferAttribute,
  );
  if (segments.length === 0) {
    context.warn({
      nodeId: context.getNodeId(line as unknown as THREE.Object3D),
      objectName: line.name,
      objectType: line.type,
      reason: "Line lowering found no drawable segments.",
    });
    return null;
  }

  const cylinders: THREE.BufferGeometry[] = [];
  for (const [start, end] of segments) {
    const length = start.distanceTo(end);
    if (length < 1e-6) {
      continue;
    }

    const geometry = new THREE.CylinderGeometry(
      radius,
      radius,
      length,
      radialSegments,
      1,
      false,
    ).toNonIndexed();

    const direction = new THREE.Vector3().subVectors(end, start).normalize();
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const rotation = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction);
    geometry.applyMatrix4(new THREE.Matrix4().compose(midpoint, rotation, UNIT_SCALE));
    cylinders.push(geometry);
  }

  if (cylinders.length === 0) {
    return null;
  }

  return mergeNonIndexedGeometries(cylinders);
}

function collectLineSegments(
  line: THREE.Line,
  position: THREE.BufferAttribute,
): Array<[THREE.Vector3, THREE.Vector3]> {
  const points = Array.from({ length: position.count }, (_, index) =>
    new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index))
  );

  const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];
  if (line instanceof THREE.LineSegments || line.type === "LineSegments") {
    for (let index = 0; index + 1 < points.length; index += 2) {
      segments.push([points[index], points[index + 1]]);
    }
    return segments;
  }

  for (let index = 0; index + 1 < points.length; index++) {
    segments.push([points[index], points[index + 1]]);
  }

  if ((line instanceof THREE.LineLoop || line.type === "LineLoop") && points.length > 2) {
    segments.push([points[points.length - 1], points[0]]);
  }

  return segments;
}

function mergeNonIndexedGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  for (const geometry of geometries) {
    vertexCount += geometry.getAttribute("position")?.count ?? 0;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  let positionOffset = 0;
  let normalOffset = 0;
  let uvOffset = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;

    positions.set(position.array as ArrayLike<number>, positionOffset);
    positionOffset += position.array.length;

    if (normal !== undefined) {
      normals.set(normal.array as ArrayLike<number>, normalOffset);
    }
    normalOffset += position.count * 3;

    if (uv !== undefined) {
      uvs.set(uv.array as ArrayLike<number>, uvOffset);
    }
    uvOffset += position.count * 2;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  merged.computeBoundingSphere();
  return merged;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
