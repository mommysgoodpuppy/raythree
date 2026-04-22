import React from "react";
import { createRoot, extend, useThree } from "@react-three/fiber";
import * as THREE from "three";

// deno-lint-ignore no-explicit-any
extend(THREE as any);

export interface R3FExtractionRootOptions {
  width: number;
  height: number;
  camera?: {
    position?: [number, number, number];
    fov?: number;
    near?: number;
    far?: number;
  };
}

export interface R3FExtractionRoot {
  render(children: React.ReactNode): void;
  getScene(): THREE.Scene | null;
  getCamera(): THREE.Camera | null;
  dispose(): void;
}

type CaptureTarget = {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
};

export async function createR3FExtractionRoot(
  options: R3FExtractionRootOptions,
): Promise<R3FExtractionRoot> {
  ensureR3FGlobals();

  const capture: CaptureTarget = {
    scene: null,
    camera: null,
  };

  const canvas = {
    width: options.width,
    height: options.height,
    style: {},
    ownerDocument: globalDocument,
    addEventListener() {},
    removeEventListener() {},
    getContext() {
      return null;
    },
  };

  const root = createRoot(canvas);
  await root.configure({
    gl: async () => createFakeRenderer(canvas),
    size: { width: options.width, height: options.height, top: 0, left: 0 },
    dpr: 1,
    camera: {
      position: options.camera?.position ?? [0, 0, 3],
      fov: options.camera?.fov ?? 50,
      near: options.camera?.near ?? 0.1,
      far: options.camera?.far ?? 1000,
    },
  });

  return {
    render(children: React.ReactNode) {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(R3FCapture, { target: capture }),
          children,
        ),
      );
    },
    getScene() {
      return capture.scene;
    },
    getCamera() {
      return capture.camera;
    },
    dispose() {
      root.unmount();
    },
  };
}

function R3FCapture({ target }: { target: CaptureTarget }) {
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  React.useLayoutEffect(() => {
    target.scene = scene;
    target.camera = camera;
  }, [camera, scene, target]);

  return null;
}

type FakeCanvas = {
  width: number;
  height: number;
  style: Record<string, unknown>;
  ownerDocument: typeof globalDocument;
  addEventListener: () => void;
  removeEventListener: () => void;
  getContext: () => null;
};

function createFakeRenderer(canvas: FakeCanvas) {
  return {
    domElement: canvas,
    xr: { enabled: false },
    shadowMap: { enabled: false },
    outputColorSpace: "srgb",
    toneMapping: 0,
    info: { render: {} },
    setPixelRatio() {},
    setSize() {},
    render() {},
    setAnimationLoop() {},
    dispose() {},
    getContext() {
      return null;
    },
  };
}

function ensureR3FGlobals() {
  const globalAny = globalThis as typeof globalThis & {
    // deno-lint-ignore no-explicit-any
    window?: any;
    requestAnimationFrame?: (cb: (time: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    document?: typeof globalDocument;
    // deno-lint-ignore no-explicit-any
    HTMLElement?: any;
    // deno-lint-ignore no-explicit-any
    ResizeObserver?: any;
  };

  globalAny.window ??= globalThis;
  globalAny.requestAnimationFrame ??= (cb: (time: number) => void): number =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  globalAny.cancelAnimationFrame ??= (id: number) => {
    clearTimeout(id as unknown as number);
  };
  globalAny.document ??= globalDocument;
  globalAny.HTMLElement ??= class HTMLElement {};
  globalAny.ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const globalDocument = {
  createElement: (_tag: string) => ({
    style: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    getContext() {
      return null;
    },
  }),
  addEventListener() {},
  removeEventListener() {},
};
