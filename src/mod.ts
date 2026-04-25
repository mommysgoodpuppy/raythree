/**
 * Full package: **library** (`lib.ts`) plus the **reference** Raylib window/renderer (`backend/`).
 *
 * Embedders that bring their own renderer (like PetPlay’s WebXR raylib path) should import from
 * `./lib.ts` only so dependency boundaries stay obvious.
 */
export * from "./lib.ts";
export * from "./backend/mod.ts";
