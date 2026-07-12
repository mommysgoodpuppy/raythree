export type AssetId = number;
export type NodeId = number;

export type PrimitiveKind = "mesh" | "instancedMesh";
export type PrimitiveTopology = "triangles";
export type MaterialKind = "unlit" | "standard" | "custom";
export type BlendMode = "opaque" | "alpha" | "add" | "multiply";
export type CullMode = "back" | "front" | "none";

export type NumericArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

export interface GeometryAttributeAsset {
  itemSize: number;
  count: number;
  normalized: boolean;
  componentType: string;
  array: NumericArray;
}

export interface GeometryIndexAsset {
  count: number;
  componentType: string;
  array: Uint16Array | Uint32Array;
}

export interface GeometryAsset {
  id: AssetId;
  topology: PrimitiveTopology;
  revision: number;
  debugLabel?: string;
  attributes: Record<string, GeometryAttributeAsset>;
  index?: GeometryIndexAsset;
  bounds?: {
    center: [number, number, number];
    radius: number;
  };
}

export interface TextureAsset {
  id: AssetId;
  revision: number;
  width: number;
  height: number;
  flipY: boolean;
  format: string;
  colorSpace: string;
  wrapS: number;
  wrapT: number;
  generateMipmaps: boolean;
  source?: string;
}

export interface RenderState {
  transparent: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  colorWrite: boolean;
  cullMode: CullMode;
  blendMode: BlendMode;
  wireframe: boolean;
}

export interface MaterialTextureBinding {
  slot: string;
  textureId: AssetId;
}

export interface MaterialAsset {
  id: AssetId;
  revision: number;
  kind: MaterialKind;
  baseColor: [number, number, number, number];
  emissiveColor?: [number, number, number];
  roughness?: number;
  metalness?: number;
  opacity: number;
  textures: MaterialTextureBinding[];
  uniforms: Record<string, number | boolean | string>;
  state: RenderState;
  debugLabel: string;
}

export interface CameraFrame {
  type: "perspective" | "orthographic";
  viewMatrix: Float32Array;
  projectionMatrix: Float32Array;
  worldMatrix: Float32Array;
  position: [number, number, number];
  near: number;
  far: number;
  fovYRadians?: number;
  zoom?: number;
}

export interface LightFrame {
  id: NodeId;
  type: "ambient" | "directional" | "point" | "spot";
  color: [number, number, number];
  intensity: number;
  position?: [number, number, number];
  direction?: [number, number, number];
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
}

export interface RenderInstance {
  kind: PrimitiveKind;
  nodeId: NodeId;
  geometryId: AssetId;
  materialId: AssetId;
  /**
   * Full double precision (Three’s `matrixWorld` is 64-bit). A `Float32` snapshot
   * added visible sub-mm stepping on long controller/laser world chains before Raylib.
   */
  worldMatrix: Float64Array;
  normalMatrix: Float64Array;
  renderOrder: number;
  layerMask: number;
  transparent: boolean;
  receiveShadow: boolean;
  castShadow: boolean;
  /**
   * When true, Raylib draws this mesh after uikit so it appears on top of panels/text
   * (e.g. controller aim beam). Set `userData.raythreeHudOverUi = true` on the Three object.
   */
  hudOverUi?: boolean;
}

export interface InstancedRenderInstance extends RenderInstance {
  kind: "instancedMesh";
  instanceMatrices: Float64Array;
  instanceCount: number;
}

export interface RenderFrame {
  camera: CameraFrame;
  lights: LightFrame[];
  instances: Array<RenderInstance | InstancedRenderInstance>;
}

export interface AssetBatch {
  geometries: GeometryAsset[];
  materials: MaterialAsset[];
  textures: TextureAsset[];
}

export interface ExtractionWarning {
  nodeId: NodeId;
  objectName: string;
  objectType: string;
  reason: string;
}

export interface ExtractionResult {
  assets: AssetBatch;
  frame: RenderFrame;
  warnings: ExtractionWarning[];
}
