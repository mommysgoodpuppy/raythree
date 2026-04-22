import * as THREE from "three";

import raylib, * as raylibBindings from "../../submodules/raylib_ts_bindings_deno/raylib_bindings.ts";
import type {
  AssetBatch,
  ExtractionResult,
  GeometryAsset,
  InstancedRenderInstance,
  MaterialAsset,
  RenderFrame,
  RenderInstance,
  TextureAsset,
} from "../ir.ts";

const MAX_MATERIAL_MAPS = 11;

export interface RaylibRendererOptions {
  raylibPath?: string;
  width?: number;
  height?: number;
  title?: string;
  hidden?: boolean;
  targetFps?: number;
  clearColor?: [number, number, number, number];
  drawMode?: "solid" | "wireframe";
  debugLights?: boolean;
}

type NativeMesh = {
  mesh: raylibBindings.Mesh;
  model?: raylibBindings.Model;
};

type NativeMaterial = {
  material: raylibBindings.Material;
  mapsBytes: Uint8Array;
  baseColor: [number, number, number, number];
  usesLighting: boolean;
};

type NativeTexture = {
  asset: TextureAsset;
};

type LightingShader = {
  shader: raylibBindings.Shader;
  lightPositionLoc: number;
  lightColorLoc: number;
  ambientColorLoc: number;
  viewPositionLoc: number;
  lightIntensityLoc: number;
  lightRangeLoc: number;
  baseColorLoc: number;
};

export class RaylibRenderer {
  private readonly clearColor: [number, number, number, number];
  private readonly drawMode: "solid" | "wireframe";
  private readonly debugLights: boolean;
  private readonly baseMaterial: raylibBindings.Material;
  private readonly lightingShader: LightingShader;
  private readonly shadowMaterial: NativeMaterial;
  private readonly geometries = new Map<number, NativeMesh>();
  private readonly materials = new Map<number, NativeMaterial>();
  private readonly textures = new Map<number, NativeTexture>();
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly shadowProjection = new THREE.Matrix4();
  private readonly shadowWorld = new THREE.Matrix4();
  private windowInitialized = false;

  constructor(options: RaylibRendererOptions = {}) {
    raylib.loadRaylib(options.raylibPath);

    if (options.hidden === true) {
      raylib.H.SetConfigFlags(raylib.ConfigFlags.FLAG_WINDOW_HIDDEN);
    }

    raylib.H.InitWindow(
      options.width ?? 1280,
      options.height ?? 720,
      options.title ?? "raythree",
    );
    this.windowInitialized = true;
    raylib.SetTargetFPS(options.targetFps ?? 60);
    this.clearColor = options.clearColor ?? [12, 18, 28, 255];
    this.drawMode = options.drawMode ?? "solid";
    this.debugLights = options.debugLights ?? true;
    this.baseMaterial = raylib.H.LoadMaterialDefault();
    this.lightingShader = createLightingShader();
    this.shadowMaterial = createShadowMaterial(this.baseMaterial);
  }

  shouldClose(): boolean {
    return raylib.H.WindowShouldClose();
  }

  syncAssets(assets: AssetBatch): void {
    for (const texture of assets.textures) {
      this.textures.set(texture.id, { asset: texture });
    }

    for (const geometry of assets.geometries) {
      const existing = this.geometries.get(geometry.id);
      if (existing !== undefined) {
        this.unloadNativeMesh(existing);
      }
      this.geometries.set(geometry.id, createNativeMesh(geometry, this.drawMode));
    }

    for (const material of assets.materials) {
      this.materials.set(
        material.id,
        createNativeMaterial(material, this.baseMaterial, this.lightingShader),
      );
    }
  }

  renderExtraction(extraction: ExtractionResult): void {
    this.syncAssets(extraction.assets);
    this.render(extraction.frame);
  }

  render(frame: RenderFrame): void {
    applyLighting(this.lightingShader, frame);

    raylib.H.BeginDrawing();
    raylib.H.ClearBackground(toRaylibColor(this.clearColor));
    raylib.H.BeginMode3D(toRaylibCamera(frame));

    for (const instance of frame.instances) {
      const nativeMesh = this.geometries.get(instance.geometryId);
      const nativeMaterial = this.materials.get(instance.materialId);
      if (nativeMesh === undefined || nativeMaterial === undefined) {
        continue;
      }

      if (isInstancedInstance(instance)) {
        this.drawInstancedFallback(instance, nativeMesh, nativeMaterial);
        continue;
      }

      this.drawNativeMesh(nativeMesh, nativeMaterial, instance.worldMatrix);
    }

    this.drawPlanarShadows(frame);
    this.drawLightDebug(frame);

    raylib.H.EndMode3D();
    raylib.H.EndDrawing();
  }

  dispose(): void {
    for (const material of this.materials.values()) {
      void material.mapsBytes;
    }
    this.materials.clear();

    for (const texture of this.textures.values()) {
      void texture;
    }
    this.textures.clear();

    for (const geometry of this.geometries.values()) {
      this.unloadNativeMesh(geometry);
    }
    this.geometries.clear();

    if (this.windowInitialized) {
      raylib.CloseWindow();
      this.windowInitialized = false;
    }
    raylib.H.UnloadShader(this.lightingShader.shader);
    raylib.unloadRaylib();
  }

  private drawInstancedFallback(
    instance: InstancedRenderInstance,
    nativeMesh: NativeMesh,
    material: NativeMaterial,
  ): void {
    this.worldMatrix.fromArray(instance.worldMatrix);

    for (let index = 0; index < instance.instanceCount; index++) {
      this.instanceMatrix.fromArray(instance.instanceMatrices, index * 16);
      this.instanceMatrix.premultiply(this.worldMatrix);
      this.drawNativeMesh(nativeMesh, material, this.instanceMatrix.elements);
    }
  }

  private drawPlanarShadows(frame: RenderFrame): void {
    const receiver = frame.instances.find((instance) =>
      !instance.transparent && instance.receiveShadow
    );
    const pointLight = frame.lights.find((light) => light.type === "point" && light.position !== undefined);
    if (receiver === undefined || pointLight?.position === undefined) {
      return;
    }

    const groundY = receiver.worldMatrix[13] + 0.01;
    for (const instance of frame.instances) {
      if (!instance.castShadow || instance.nodeId === receiver.nodeId) {
        continue;
      }

      const nativeMesh = this.geometries.get(instance.geometryId);
      if (nativeMesh === undefined) {
        continue;
      }

      if (isInstancedInstance(instance)) {
        this.worldMatrix.fromArray(instance.worldMatrix);
        for (let index = 0; index < instance.instanceCount; index++) {
          this.instanceMatrix.fromArray(instance.instanceMatrices, index * 16);
          this.instanceMatrix.premultiply(this.worldMatrix);
          this.drawProjectedShadow(nativeMesh.mesh, this.instanceMatrix, pointLight.position, groundY);
        }
        continue;
      }

      this.worldMatrix.fromArray(instance.worldMatrix);
      this.drawProjectedShadow(nativeMesh.mesh, this.worldMatrix, pointLight.position, groundY);
    }
  }

  private drawProjectedShadow(
    mesh: raylibBindings.Mesh,
    worldMatrix: THREE.Matrix4,
    lightPosition: [number, number, number],
    groundY: number,
  ): void {
    this.shadowProjection.copy(buildPlanarShadowProjection(lightPosition, groundY));
    this.shadowWorld.copy(worldMatrix).premultiply(this.shadowProjection);
    raylib.H.DrawMesh(
      mesh,
      this.shadowMaterial.material,
      toRaylibMatrix(this.shadowWorld.elements),
    );
  }

  private drawLightDebug(frame: RenderFrame): void {
    if (!this.debugLights) {
      return;
    }

    for (const light of frame.lights) {
      if (
        (light.type === "point" || light.type === "spot") &&
        light.position !== undefined
      ) {
        const radius = light.type === "point" ? 0.08 : 0.06;
        raylib.H.DrawSphere(
          { x: light.position[0], y: light.position[1], z: light.position[2] },
          radius,
          toRaylibColor([
            light.color[0] * 255,
            light.color[1] * 255,
            light.color[2] * 255,
            255,
          ]),
        );
      }
    }
  }

  private drawNativeMesh(
    nativeMesh: NativeMesh,
    material: NativeMaterial,
    worldMatrix: ArrayLike<number>,
  ): void {
    if (material.usesLighting) {
      setShaderVec4(this.lightingShader.shader, this.lightingShader.baseColorLoc, material.baseColor);
    }

    if (this.drawMode === "wireframe" && nativeMesh.model !== undefined) {
      drawModelWiresWithMatrix(nativeMesh.model, worldMatrix, raylib.WHITE);
      return;
    }

    raylib.H.DrawMesh(
      nativeMesh.mesh,
      material.material,
      toRaylibMatrix(worldMatrix),
    );
  }

  private unloadNativeMesh(nativeMesh: NativeMesh): void {
    if (nativeMesh.model !== undefined) {
      raylib.H.UnloadModel(nativeMesh.model);
      return;
    }
    raylib.H.UnloadMesh(nativeMesh.mesh);
  }
}

function createNativeMaterial(
  asset: MaterialAsset,
  baseMaterial: raylibBindings.Material,
  lightingShader: LightingShader,
): NativeMaterial {
  const mapsBytes = cloneMaterialMaps(baseMaterial);
  const albedoMap = readMaterialMap(
    mapsBytes,
    raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
  );

  writeMaterialMap(mapsBytes, raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO, {
    ...albedoMap,
    color: toRaylibColor([
      asset.baseColor[0] * 255,
      asset.baseColor[1] * 255,
      asset.baseColor[2] * 255,
      asset.baseColor[3] * 255,
    ]),
  });

  const usesLighting = asset.kind === "standard";
  const material = {
    shader: usesLighting ? lightingShader.shader : baseMaterial.shader,
    maps: pointerAddress(mapsBytes),
    params: [...baseMaterial.params] as [number, number, number, number],
  } as unknown as raylibBindings.Material;

  return {
    material,
    mapsBytes,
    baseColor: asset.baseColor,
    usesLighting,
  };
}

function createShadowMaterial(
  baseMaterial: raylibBindings.Material,
): NativeMaterial {
  const mapsBytes = cloneMaterialMaps(baseMaterial);
  const albedoMap = readMaterialMap(
    mapsBytes,
    raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO,
  );

  writeMaterialMap(mapsBytes, raylibBindings.MaterialMapIndex.MATERIAL_MAP_ALBEDO, {
    ...albedoMap,
    color: { r: 0, g: 0, b: 0, a: 140 },
  });

  const material = {
    shader: baseMaterial.shader,
    maps: pointerAddress(mapsBytes),
    params: [...baseMaterial.params] as [number, number, number, number],
  } as unknown as raylibBindings.Material;

  return {
    material,
    mapsBytes,
    baseColor: [0, 0, 0, 0.55],
    usesLighting: false,
  };
}

function createLightingShader(): LightingShader {
  const shader = raylib.H.LoadShaderFromMemory(
    LIGHTING_VERTEX_SHADER,
    LIGHTING_FRAGMENT_SHADER,
  );

  return {
    shader,
    lightPositionLoc: raylib.H.GetShaderLocation(shader, "uLightPosition"),
    lightColorLoc: raylib.H.GetShaderLocation(shader, "uLightColor"),
    ambientColorLoc: raylib.H.GetShaderLocation(shader, "uAmbientColor"),
    viewPositionLoc: raylib.H.GetShaderLocation(shader, "uViewPosition"),
    lightIntensityLoc: raylib.H.GetShaderLocation(shader, "uLightIntensity"),
    lightRangeLoc: raylib.H.GetShaderLocation(shader, "uLightRange"),
    baseColorLoc: raylib.H.GetShaderLocation(shader, "uBaseColor"),
  };
}

function applyLighting(shader: LightingShader, frame: RenderFrame): void {
  const ambient = frame.lights.filter((light) => light.type === "ambient");
  const ambientColor = ambient.reduce<[number, number, number]>(
    (acc, light) => [
      acc[0] + light.color[0] * light.intensity,
      acc[1] + light.color[1] * light.intensity,
      acc[2] + light.color[2] * light.intensity,
    ],
    [0.1, 0.1, 0.12],
  );

  const point = frame.lights.find((light) => light.type === "point" && light.position !== undefined);
  const lightPosition = point?.position ?? [0, 6, 0];
  const lightColor = point?.color ?? [1, 1, 1];
  const lightIntensity = point?.intensity ?? 0;
  const lightRange = point?.distance ?? 0;

  setShaderVec3(shader.shader, shader.lightPositionLoc, lightPosition);
  setShaderVec3(shader.shader, shader.lightColorLoc, lightColor);
  setShaderVec3(shader.shader, shader.ambientColorLoc, ambientColor);
  setShaderVec3(shader.shader, shader.viewPositionLoc, frame.camera.position);
  setShaderFloat(shader.shader, shader.lightIntensityLoc, lightIntensity);
  setShaderFloat(shader.shader, shader.lightRangeLoc, lightRange);
}

function writeMaterialMap(
  bytes: Uint8Array,
  index: number,
  value: raylibBindings.MaterialMap,
): void {
  const offset = index * raylibBindings.MaterialMap.byteSize;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    raylibBindings.MaterialMap.byteSize,
  );
  raylibBindings.MaterialMap.writeBytes(value, view);
}

function readMaterialMap(
  bytes: Uint8Array,
  index: number,
): raylibBindings.MaterialMap {
  const offset = index * raylibBindings.MaterialMap.byteSize;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    raylibBindings.MaterialMap.byteSize,
  );
  return raylibBindings.MaterialMap.readBytes(view);
}

function cloneMaterialMaps(
  baseMaterial: raylibBindings.Material,
): Uint8Array {
  const bytes = new Uint8Array(
    raylibBindings.MaterialMap.byteSize * MAX_MATERIAL_MAPS,
  );
  const mapsPointer = pointerFromAddress(baseMaterial.maps);
  if (mapsPointer === null) {
    return bytes;
  }

  new Deno.UnsafePointerView(mapsPointer).copyInto(bytes);
  return bytes;
}

function createNativeMesh(
  asset: GeometryAsset,
  drawMode: "solid" | "wireframe",
): NativeMesh {
  const prepared = prepareGeometryBuffers(asset);
  const meshHandle = raylibBindings.Mesh.createPointer({
    vertexCount: prepared.vertexCount,
    triangleCount: prepared.triangleCount,
    vertices: pointerAddress(prepared.vertices),
    texcoords: pointerAddress(prepared.texcoords),
    texcoords2: ZERO_POINTER,
    normals: pointerAddress(prepared.normals),
    tangents: ZERO_POINTER,
    colors: pointerAddress(prepared.colors),
    indices: prepared.indices === null
      ? ZERO_POINTER
      : pointerAddress(prepared.indices),
    animVertices: ZERO_POINTER,
    animNormals: ZERO_POINTER,
    boneIds: ZERO_POINTER,
    boneWeights: ZERO_POINTER,
    boneMatrices: ZERO_POINTER,
    boneCount: 0,
    vaoId: 0,
    vboId: ZERO_POINTER,
  } as unknown as raylibBindings.Mesh);

  raylib.H.UploadMesh(meshHandle.pointer, false);
  const uploaded = meshHandle.read();
  const sanitized = sanitizeUploadedMesh(uploaded);
  meshHandle.write(sanitized);

  if (drawMode === "wireframe") {
    return {
      mesh: sanitized,
      model: raylib.H.LoadModelFromMesh(sanitized),
    };
  }

  return { mesh: sanitized };
}

function sanitizeUploadedMesh(mesh: raylibBindings.Mesh): raylibBindings.Mesh {
  return {
    ...mesh,
    vertices: ZERO_POINTER,
    texcoords: ZERO_POINTER,
    texcoords2: ZERO_POINTER,
    normals: ZERO_POINTER,
    tangents: ZERO_POINTER,
    colors: ZERO_POINTER,
    indices: ZERO_POINTER,
    animVertices: ZERO_POINTER,
    animNormals: ZERO_POINTER,
    boneIds: ZERO_POINTER,
    boneWeights: ZERO_POINTER,
    boneMatrices: ZERO_POINTER,
    vboId: ZERO_POINTER,
  } as unknown as raylibBindings.Mesh;
}

type PreparedGeometryBuffers = {
  vertexCount: number;
  triangleCount: number;
  vertices: Float32Array;
  texcoords: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint16Array | null;
};

function prepareGeometryBuffers(asset: GeometryAsset): PreparedGeometryBuffers {
  const position = asset.attributes.position;
  if (position === undefined || position.itemSize !== 3) {
    throw new Error(`Geometry ${asset.id} is missing a vec3 position attribute.`);
  }

  const texcoord = asset.attributes.uv;
  const normal = asset.attributes.normal;
  const color = asset.attributes.color;

  if (asset.index !== undefined) {
    return expandIndexedGeometry(asset, position, texcoord, normal, color);
  }

  const vertexCount = position.count;
  const vertices = toFloat32Array(position.array);
  const texcoords = texcoord === undefined
    ? new Float32Array(vertexCount * 2)
    : toFloat32Array(texcoord.array);
  const normals = normal === undefined
    ? new Float32Array(vertexCount * 3)
    : toFloat32Array(normal.array);
  const colors = color === undefined
    ? buildOpaqueWhiteColors(vertexCount)
    : toColorBytes(color.array);

  return {
    vertexCount,
    triangleCount: vertexCount / 3,
    vertices,
    texcoords,
    normals,
    colors,
    indices: null,
  };
}

function expandIndexedGeometry(
  asset: GeometryAsset,
  position: GeometryAsset["attributes"]["position"],
  texcoord: GeometryAsset["attributes"]["uv"] | undefined,
  normal: GeometryAsset["attributes"]["normal"] | undefined,
  color: GeometryAsset["attributes"]["color"] | undefined,
): PreparedGeometryBuffers {
  const index = asset.index;
  if (index === undefined) {
    throw new Error(`Geometry ${asset.id} requested indexed expansion without an index buffer.`);
  }

  const expandedVertexCount = index.count;
  const positions = new Float32Array(expandedVertexCount * 3);
  const texcoords = new Float32Array(expandedVertexCount * 2);
  const normals = new Float32Array(expandedVertexCount * 3);
  const colors = new Uint8Array(expandedVertexCount * 4);

  for (let expanded = 0; expanded < index.count; expanded++) {
    const source = index.array[expanded];
    positions.set(readTuple(position.array, source, 3), expanded * 3);
    if (texcoord !== undefined) {
      texcoords.set(readTuple(texcoord.array, source, 2), expanded * 2);
    }
    if (normal !== undefined) {
      normals.set(readTuple(normal.array, source, 3), expanded * 3);
    }
    if (color !== undefined) {
      colors.set(toColorTuple(color.array, source), expanded * 4);
    } else {
      colors.set([255, 255, 255, 255], expanded * 4);
    }
  }

  return {
    vertexCount: expandedVertexCount,
    triangleCount: expandedVertexCount / 3,
    vertices: positions,
    texcoords,
    normals,
    colors,
    indices: null,
  };
}

function readTuple(array: ArrayLike<number>, index: number, itemSize: number): number[] {
  const start = index * itemSize;
  return Array.from({ length: itemSize }, (_, offset) => Number(array[start + offset] ?? 0));
}

function toFloat32Array(array: ArrayLike<number>): Float32Array {
  return array instanceof Float32Array ? array.slice() : Float32Array.from(array);
}

function toColorBytes(array: ArrayLike<number>): Uint8Array {
  if (array instanceof Uint8Array) {
    return array.slice();
  }
  const bytes = new Uint8Array(array.length);
  for (let index = 0; index < array.length; index++) {
    const value = Number(array[index] ?? 1);
    bytes[index] = value <= 1 ? Math.round(value * 255) : Math.round(value);
  }
  return bytes;
}

function toColorTuple(array: ArrayLike<number>, index: number): [number, number, number, number] {
  const offset = index * 4;
  const rgba = [array[offset], array[offset + 1], array[offset + 2], array[offset + 3]];
  return rgba.map((value, channelIndex) => {
    const fallback = channelIndex === 3 ? 1 : 0;
    const numeric = Number(value ?? fallback);
    return numeric <= 1 ? Math.round(numeric * 255) : Math.round(numeric);
  }) as [number, number, number, number];
}

function buildOpaqueWhiteColors(vertexCount: number): Uint8Array {
  const colors = new Uint8Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index++) {
    colors.set([255, 255, 255, 255], index * 4);
  }
  return colors;
}

function isInstancedInstance(
  instance: RenderInstance | InstancedRenderInstance,
): instance is InstancedRenderInstance {
  return instance.kind === "instancedMesh";
}

function pointerAddress(value: unknown): bigint {
  const pointer = Deno.UnsafePointer.of(value as BufferSource);
  if (pointer === null) {
    return ZERO_POINTER;
  }
  return Deno.UnsafePointer.value(pointer);
}

function pointerFromAddress(address: unknown): Deno.PointerValue<unknown> {
  if (typeof address !== "bigint" || address === ZERO_POINTER) {
    return null;
  }
  return Deno.UnsafePointer.create(address);
}

const ZERO_POINTER = 0n;

function toRaylibCamera(frame: RenderFrame): raylibBindings.Camera3D {
  const world = frame.camera.worldMatrix;
  const position = {
    x: frame.camera.position[0],
    y: frame.camera.position[1],
    z: frame.camera.position[2],
  };
  const forward = new THREE.Vector3(-world[8], -world[9], -world[10]).normalize();
  const up = new THREE.Vector3(world[4], world[5], world[6]).normalize();
  const target = {
    x: position.x + forward.x,
    y: position.y + forward.y,
    z: position.z + forward.z,
  };

  return {
    position,
    target,
    up: { x: up.x, y: up.y, z: up.z },
    fovy: frame.camera.type === "perspective"
      ? THREE.MathUtils.radToDeg(frame.camera.fovYRadians ?? Math.PI / 3)
      : frame.camera.zoom ?? 1,
    projection: frame.camera.type === "perspective"
      ? raylibBindings.CameraProjection.CAMERA_PERSPECTIVE
      : raylibBindings.CameraProjection.CAMERA_ORTHOGRAPHIC,
  };
}

function toRaylibColor(
  rgba: [number, number, number, number],
): raylibBindings.Color {
  return {
    r: Math.max(0, Math.min(255, Math.round(rgba[0]))),
    g: Math.max(0, Math.min(255, Math.round(rgba[1]))),
    b: Math.max(0, Math.min(255, Math.round(rgba[2]))),
    a: Math.max(0, Math.min(255, Math.round(rgba[3]))),
  };
}

function toRaylibMatrix(
  elements: ArrayLike<number>,
): raylibBindings.Matrix {
  return {
    m0: Number(elements[0]),
    m4: Number(elements[4]),
    m8: Number(elements[8]),
    m12: Number(elements[12]),
    m1: Number(elements[1]),
    m5: Number(elements[5]),
    m9: Number(elements[9]),
    m13: Number(elements[13]),
    m2: Number(elements[2]),
    m6: Number(elements[6]),
    m10: Number(elements[10]),
    m14: Number(elements[14]),
    m3: Number(elements[3]),
    m7: Number(elements[7]),
    m11: Number(elements[11]),
    m15: Number(elements[15]),
  };
}

function drawModelWiresWithMatrix(
  model: raylibBindings.Model,
  worldMatrix: ArrayLike<number>,
  tint: raylibBindings.Color,
): void {
  const matrix = new THREE.Matrix4().fromArray(Array.from(worldMatrix, Number));
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const axis = new THREE.Vector3(0, 1, 0);

  matrix.decompose(position, quaternion, scale);

  let angle = 0;
  if (Math.abs(quaternion.w) < 0.999999) {
    angle = 2 * Math.acos(quaternion.w);
    const s = Math.sqrt(1 - quaternion.w * quaternion.w);
    if (s > 0.0001) {
      axis.set(quaternion.x / s, quaternion.y / s, quaternion.z / s);
    }
  }

  raylib.H.DrawModelWiresEx(
    model,
    { x: position.x, y: position.y, z: position.z },
    { x: axis.x, y: axis.y, z: axis.z },
    THREE.MathUtils.radToDeg(angle),
    { x: scale.x, y: scale.y, z: scale.z },
    tint,
  );
}

function setShaderVec3(
  shader: raylibBindings.Shader,
  location: number,
  value: [number, number, number],
): void {
  if (location < 0) {
    return;
  }
  const vec = new Float32Array(value);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(vec),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_VEC3,
  );
}

function setShaderFloat(
  shader: raylibBindings.Shader,
  location: number,
  value: number,
): void {
  if (location < 0) {
    return;
  }
  const scalar = new Float32Array([value]);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(scalar),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_FLOAT,
  );
}

function setShaderVec4(
  shader: raylibBindings.Shader,
  location: number,
  value: [number, number, number, number],
): void {
  if (location < 0) {
    return;
  }
  const vec = new Float32Array(value);
  raylib.H.SetShaderValue(
    shader,
    location,
    Deno.UnsafePointer.of(vec),
    raylibBindings.ShaderUniformDataType.SHADER_UNIFORM_VEC4,
  );
}

function buildPlanarShadowProjection(
  lightPosition: [number, number, number],
  groundY: number,
): THREE.Matrix4 {
  const plane: [number, number, number, number] = [0, 1, 0, -groundY];
  const light: [number, number, number, number] = [
    lightPosition[0],
    lightPosition[1],
    lightPosition[2],
    1,
  ];
  const dot = plane[0] * light[0] + plane[1] * light[1] + plane[2] * light[2] + plane[3] * light[3];

  return new THREE.Matrix4().set(
    dot - light[0] * plane[0],
    -light[0] * plane[1],
    -light[0] * plane[2],
    -light[0] * plane[3],
    -light[1] * plane[0],
    dot - light[1] * plane[1],
    -light[1] * plane[2],
    -light[1] * plane[3],
    -light[2] * plane[0],
    -light[2] * plane[1],
    dot - light[2] * plane[2],
    -light[2] * plane[3],
    -light[3] * plane[0],
    -light[3] * plane[1],
    -light[3] * plane[2],
    dot - light[3] * plane[3],
  );
}

const LIGHTING_VERTEX_SHADER = `#version 330
in vec3 vertexPosition;
in vec2 vertexTexCoord;
in vec3 vertexNormal;
in vec4 vertexColor;

uniform mat4 mvp;
uniform mat4 matModel;

out vec3 fragPosition;
out vec3 fragNormal;
out vec2 fragTexCoord;
out vec4 fragColor;

void main() {
  vec4 worldPosition = matModel * vec4(vertexPosition, 1.0);
  fragPosition = worldPosition.xyz;
  fragNormal = normalize(mat3(transpose(inverse(matModel))) * vertexNormal);
  fragTexCoord = vertexTexCoord;
  fragColor = vertexColor;
  gl_Position = mvp * vec4(vertexPosition, 1.0);
}
`;

const LIGHTING_FRAGMENT_SHADER = `#version 330
in vec3 fragPosition;
in vec3 fragNormal;
in vec2 fragTexCoord;
in vec4 fragColor;

uniform sampler2D texture0;
uniform vec4 uBaseColor;
uniform vec3 uLightPosition;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uViewPosition;
uniform float uLightIntensity;
uniform float uLightRange;

out vec4 finalColor;

void main() {
  vec4 albedo = texture(texture0, fragTexCoord) * uBaseColor * fragColor;
  vec3 normal = normalize(fragNormal);
  vec3 lightVector = uLightPosition - fragPosition;
  float lightDistance = max(length(lightVector), 0.0001);
  vec3 lightDirection = lightVector / lightDistance;

  float attenuation = 1.0 / (1.0 + 0.09 * lightDistance + 0.032 * lightDistance * lightDistance);
  if (uLightRange > 0.0) {
    attenuation *= clamp(1.0 - (lightDistance / uLightRange), 0.0, 1.0);
  }

  float diffuse = max(dot(normal, lightDirection), 0.0);
  vec3 viewDirection = normalize(uViewPosition - fragPosition);
  vec3 halfVector = normalize(lightDirection + viewDirection);
  float specular = pow(max(dot(normal, halfVector), 0.0), 24.0) * 0.18;

  vec3 lighting = uAmbientColor + uLightColor * (diffuse + specular) * uLightIntensity * attenuation;
  finalColor = vec4(albedo.rgb * lighting, albedo.a);
}
`;
