/**
 * Scene store schema: tables, their field groups, and the value shape of each group.
 *
 * glTF-aligned (nodes, geometries, materials, textures, lights) plus `items`, which bind a node
 * to something drawable. A field group is the unit of change tracking: a write to one group
 * marks only that group, so a renderer can tell a transform update from a rebind.
 */

export type RowId = number;

/** Tables in apply order: anything an item refers to is applied before it. */
export const TABLES = ["textures", "geometries", "materials", "nodes", "lights", "items"] as const;
export type TableName = typeof TABLES[number];

export const GROUPS = {
  textures: ["meta", "source"],
  geometries: ["data"],
  materials: ["model", "state"],
  nodes: ["structure", "transform"],
  lights: ["light", "placement"],
  items: ["header", "transform", "state", "data"],
} as const satisfies Record<TableName, readonly string[]>;

export type GroupName<T extends TableName> = typeof GROUPS[T][number];

export type Matrix4 = Float64Array; // column-major, 16 elements

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

// ---- textures ----

export interface TextureMeta {
  width: number;
  height: number;
  format: string;
  colorSpace: string;
  flipY: boolean;
  generateMipmaps: boolean;
  wrapS: "repeat" | "clamp" | "mirror";
  wrapT: "repeat" | "clamp" | "mirror";
}

/** Pixels (or an encoded image) travel with the texture; `uri` is a fallback lookup key. */
export interface TextureSource {
  uri: string | null;
  mimeType: string | null;
  bytes: Uint8Array | null;
}

// ---- geometries (a glTF mesh primitive's vertex data) ----

export interface GeometryAttribute {
  itemSize: number;
  normalized: boolean;
  array: NumericArray;
}

export interface GeometryData {
  topology: "triangles";
  attributes: Record<string, GeometryAttribute>;
  index: Uint16Array | Uint32Array | null;
  bounds: { center: [number, number, number]; radius: number } | null;
}

// ---- materials ----

export interface MaterialTextureRef {
  slot: string;
  texture: RowId;
}

/**
 * `unlit` and `pbr` (metallic-roughness) are core; anything else is an extension name, drawn by
 * renderers that know it and by `fallback` otherwise.
 */
export interface MaterialModel {
  model: string;
  fallback: "unlit" | "pbr" | "skip";
  /** sRGB-encoded 0..1, as raythree's IR. */
  baseColor: [number, number, number, number];
  emissive: [number, number, number] | null;
  roughness: number | null;
  metalness: number | null;
  vertexColors: boolean;
  textures: MaterialTextureRef[];
  /** Extension parameters, keyed by extension name. */
  extensions: Record<string, unknown>;
}

export interface MaterialState {
  blend: "opaque" | "alpha" | "add" | "multiply";
  cull: "back" | "front" | "none";
  depthTest: boolean;
  depthWrite: boolean;
  colorWrite: boolean;
  wireframe: boolean;
}

// ---- nodes ----

/**
 * Tracked spaces are filled in by the renderer at draw time (late latching), never by the
 * producer. Names follow WebXR: viewer, grip and target-ray spaces per hand.
 */
export type TrackedSpace = "viewer" | "left-grip" | "right-grip" | "left-ray" | "right-ray";

/**
 * A node held between two tracked spaces (a two-hand grab): origin at the midpoint of the two
 * grab points, x from the first to the second, uniformly scaled by their distance.
 */
export interface TrackedPair {
  first: TrackedSpace;
  second: TrackedSpace;
  /** Each grab point in its own space. */
  points: [[number, number, number], [number, number, number]];
}

/**
 * A node's world matrix is its parent's world matrix times its own `transform`, except for a
 * tracked node: the renderer sets its world matrix from its own tracking, ignoring `parent` and
 * `transform`. A renderer without tracking of its own (a desktop view) takes these poses from the
 * producer's tracked-pose lane, which is separate from the store so poses never dirty it.
 */
export interface NodeStructure {
  parent: RowId | null;
  tracked: TrackedSpace | TrackedPair | null;
}

// ---- lights ----

export interface LightData {
  type: "ambient" | "directional" | "point" | "spot";
  /** Linear RGB. */
  color: [number, number, number];
  intensity: number;
  range: number | null;
  decay: number | null;
  innerConeAngle: number | null;
  outerConeAngle: number | null;
}

/** Lights shine down their node-local -Z, as in glTF. */
export interface Placement {
  node: RowId;
  matrix: Matrix4;
}

// ---- items ----

export interface ItemHeader {
  kind: string;
  node: RowId;
}

export interface ItemState {
  visible: boolean;
  layerMask: number;
  /** Explicit draw order within a pass; ties fall back to the renderer's own sort. */
  order: number;
  /** Needs view-dependent depth sorting (transparent), rather than a stable order. */
  depthSorted: boolean;
}

export interface MeshItemData {
  geometry: RowId;
  material: RowId;
  castShadow: boolean;
  receiveShadow: boolean;
  /** Draw after UI, on top of panels (raythree's `hudOverUi`). */
  overlay: boolean;
  /** Present for `instancedMesh`: per-instance node-local matrices. */
  instances: Float64Array | null;
  instanceCount: number;
  /** Extension flags and values, keyed by name. */
  extensions: Record<string, unknown>;
}

// ---- UI item kinds ----
//
// Flat UI as drawn by uikit-style toolkits: rounded rectangles and MSDF text runs, in the item's
// own space, measured in UI pixels. The item transform maps UI pixels to node space.

/**
 * Draw order among UI items, which draw without depth testing against each other.
 *
 * `root` names an independent UI root: the renderer sorts roots back to front by view depth,
 * because no order exists between them. Within a root, items draw in lexicographic order of the
 * remaining fields: `layer` (0 quads, 1 text), then the toolkit's own keys, then `slot` (the
 * toolkit's allocation order, fractional for an image fill drawn right after its panel).
 */
export type UiOrder = [
  root: number,
  layer: number,
  renderOrder: number,
  major: number,
  minor: number,
  elementType: number,
  patch: number,
  slot: number,
];

/**
 * Four clip planes in **node space**, 16 floats: a point x is kept where
 * `dot(plane.xyz, x) + plane.w > 0` for every plane. Null: unclipped.
 */
export type ClipPlanes = Float64Array | null;

/**
 * `uiQuad`: a rounded rectangle, the unit square [-0.5, 0.5]² of the item transform, with a
 * border and either a flat fill or an image fill (the image goes through the same rounded
 * corners).
 */
export interface UiQuadData {
  /** Size in UI pixels, for border and corner geometry (the transform already scales the quad). */
  size: [number, number];
  /** Top, right, bottom, left, in UI pixels. */
  borderWidth: [number, number, number, number];
  /** Top-left, top-right, bottom-right, bottom-left, in UI pixels. */
  borderRadius: [number, number, number, number];
  borderBend: number;
  /** sRGB-encoded 0..1, alpha straight. */
  background: [number, number, number, number];
  border: [number, number, number, number];
  image: UiImageFill | null;
  clip: ClipPlanes;
  depthTest: boolean;
  depthWrite: boolean;
  uiOrder: UiOrder;
}

export interface UiImageFill {
  texture: RowId;
  fit: "cover" | "stretch";
  /** Focal point for `cover`, 0..1 per axis. */
  focus: [number, number];
  opacity: number;
}

/**
 * `textRun`: MSDF glyph quads, already shaped by the producer (layout depends on measured text,
 * so the producer's shaping is authoritative). `glyphs` holds 8 floats per glyph in item space:
 * x0, y0, x1, y1, then the atlas UV rectangle u0, v0, u1, v1 (u0,v0 belongs to corner x0,y0).
 */
export interface TextRunData {
  text: string;
  /** The MSDF atlas texture. */
  atlas: RowId;
  /** The atlas's distance range in pixels (msdfgen's pxRange). */
  pxRange: number;
  /** sRGB-encoded 0..1, alpha straight. */
  color: [number, number, number, number];
  glyphs: Float32Array;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  clip: ClipPlanes;
  uiOrder: UiOrder;
}

// ---- video ----

/**
 * A surface showing part of a media feed (a desktop capture, a remote stream). The pixels never
 * enter the store: `feed` names a track the renderer receives over its media transport, and the
 * store says where it appears. `geometry` is the surface in item space; its UVs span 0..1 over the
 * shown region, which is `crop` of the feed's picture (normalized, top-left origin, y down).
 */
export interface VideoSurfaceData {
  feed: string;
  geometry: RowId;
  crop: { x: number; y: number; width: number; height: number };
  opacity: number;
}

export interface TableRows {
  textures: { meta: TextureMeta; source: TextureSource };
  geometries: { data: GeometryData };
  materials: { model: MaterialModel; state: MaterialState };
  nodes: { structure: NodeStructure; transform: Matrix4 };
  lights: { light: LightData; placement: Placement };
  items: { header: ItemHeader; transform: Matrix4; state: ItemState; data: unknown };
}

export type Row<T extends TableName> = TableRows[T];

/** The world root: every store has it, at this id, with an identity transform. */
export const WORLD_NODE: RowId = 0;

export function tableIndex(table: TableName): number {
  return TABLES.indexOf(table);
}

export function groupIndex<T extends TableName>(table: T, group: GroupName<T>): number {
  return (GROUPS[table] as readonly string[]).indexOf(group);
}

export function allGroupsMask(table: TableName): number {
  return (1 << GROUPS[table].length) - 1;
}

export function identityMatrix(): Matrix4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
