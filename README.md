# raythree

Three.js scene → portable render **intermediate representation** (`ExtractionResult`), with optional helpers.

## Library (what embedders depend on)

Use **`src/lib.ts`** as the single import surface for production integrations:

| Area | Role |
|------|------|
| `src/extract.ts` | `RaythreeExtractor`: scene + camera → `ExtractionResult` |
| `src/ir.ts` | IR types (instances, materials, geometry assets, camera frame, …) |
| `src/lowerers.ts` | Pluggable lowering from Three materials/meshes into the IR |
| `src/ids.ts` | Stable IDs for scene objects across extractions |
| `src/r3f_runtime.ts` | `createR3FExtractionRoot` for React Three Fiber |

Example:

```ts
import { RaythreeExtractor } from "./src/lib.ts";
```

Downstream projects (e.g. **PetPlay**) typically depend only on this layer and implement their own renderer.

## Reference backend (not required for embedders)

**`src/backend/raylib.ts`** exposes `RaylibRenderer`: a desktop Raylib window that draws `ExtractionResult`. It is **reference / demo** quality for local testing, not part of the minimal library contract.

Import it via the full barrel if you need it:

```ts
import { RaylibRenderer, RaythreeExtractor } from "./src/mod.ts";
```

## Examples (not part of the library)

Everything under **`examples/`** is standalone usage (desktop loop, R3F + Raylib, WebGPU extract checks, etc.). It is not imported by the library core.

## Tasks

- `deno task check` — typecheck library + examples.
