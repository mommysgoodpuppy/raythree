/**
 * Stable **library** surface for embedders (e.g. custom renderers that consume `ExtractionResult`).
 *
 * Does not include the optional Raylib desktop backend (`src/backend/`). Import `mod.ts` only if you
 * need `RaylibRenderer` or other reference backends.
 */
export * from "./extract.ts";
export * from "./ids.ts";
export * from "./ir.ts";
export * from "./lowerers.ts";
export * from "./r3f_runtime.ts";
