export * from "./schema.ts";
export { copyValue, type Hash, hashValue, valuesEqual } from "./values.ts";
export {
  type DeltaRow,
  type DeltaTable,
  type SceneDelta,
  SceneStore,
  StoreDivergence,
  type TouchedRow,
} from "./store.ts";
export { decodeDelta, encodeDelta } from "./codec.ts";
export {
  ExtractionStoreWriter,
  type ExtractionWriterOptions,
  type ItemPlacement,
  type WriteStats,
} from "./extractionWriter.ts";
