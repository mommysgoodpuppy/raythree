import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  decodeDelta,
  encodeDelta,
  ExtractionStoreWriter,
  GROUPS,
  type SceneDelta,
  SceneStore,
  StoreDivergence,
  TABLES,
  type TableName,
  type TouchedRow,
  valuesEqual,
} from "./mod.ts";
import type { ExtractionResult } from "../ir.ts";

const matrix = (tx = 0) => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = tx;
  return m;
};

function item(node = 0, tx = 0, color = 1) {
  return {
    header: { kind: "mesh", node },
    transform: matrix(tx),
    state: { visible: true, layerMask: 1, order: 0, depthSorted: false },
    data: { geometry: 1, material: color, extensions: {} },
  };
}

function rowsOf(store: SceneStore) {
  const out: Record<string, Record<number, unknown>> = {};
  for (const table of TABLES) {
    out[table] = {};
    for (const id of store.ids(table)) out[table]![id] = store.get(table, id);
  }
  return out;
}

function assertSameState(a: SceneStore, b: SceneStore) {
  assertEquals(a.hash(), b.hash());
  assert(valuesEqual(rowsOf(a), rowsOf(b)), "replica rows differ from the producer's");
}

const wire = (delta: SceneDelta) => decodeDelta(encodeDelta(delta));

Deno.test("an equal write commits nothing", () => {
  const store = new SceneStore();
  store.write("items", 1, item());
  const tick = store.tick;
  assertEquals(store.write("items", 1, item()), false);
  assertEquals(store.write("items", 1, { transform: matrix(0) }), false);
  assertEquals(store.tick, tick);
  assertEquals(store.changesSince(tick)!.tables, []);
});

Deno.test("a delta carries only the changed group", () => {
  const store = new SceneStore();
  store.write("items", 1, item());
  store.write("items", 2, item());
  const from = store.tick;
  store.write("items", 1, { transform: matrix(0.5) });
  const delta = store.changesSince(from)!;
  assertEquals(delta.tables.length, 1);
  const [row] = delta.tables[0]!.upserts;
  assertEquals(row!.id, 1);
  assertEquals(row!.full, false);
  assertEquals(row!.mask, 1 << GROUPS.items.indexOf("transform"));
  assertEquals((row!.values[0] as Float64Array)[12], 0.5);
});

Deno.test("writes copy reused producer buffers", () => {
  const store = new SceneStore();
  const shared = matrix(1);
  store.write("items", 1, { ...item(), transform: shared });
  shared[12] = 2;
  assertEquals((store.get("items", 1)!.transform as Float64Array)[12], 1);
  assertEquals(store.write("items", 1, { transform: shared }), true);
});

Deno.test("transactions merge repeated writes into one journal entry", () => {
  const store = new SceneStore();
  const touched: TouchedRow[][] = [];
  store.onTransaction((rows) => touched.push(rows));
  store.transaction(() => {
    store.write("items", 1, item());
    store.write("items", 1, { transform: matrix(1) });
    store.write("items", 1, { transform: matrix(2) });
  });
  assertEquals(store.journalLength(), 1);
  assertEquals(touched.length, 1);
  assertEquals(touched[0]!.length, 1);
  assertEquals(touched[0]![0]!.removed, false);
});

Deno.test("remove and re-create within and across transactions", () => {
  const producer = new SceneStore();
  const replica = new SceneStore();
  producer.write("items", 1, item(0, 1));
  replica.apply(wire(producer.snapshot()));
  let ack = producer.tick;

  // Existed, removed and re-created in one transaction: a full replace, not a partial update.
  producer.transaction(() => {
    producer.remove("items", 1);
    producer.write("items", 1, item(0, 2, 7));
  });
  const replaced = producer.changesSince(ack)!;
  // The renderer must treat it as a new object (its kind may differ), not patch the old one.
  assertEquals(replaced.tables[0]!.upserts[0]!.full, true);
  replica.apply(wire(replaced));
  ack = producer.tick;
  assertSameState(producer, replica);

  // Across transactions, with the remove later in the range than an ordinary update.
  producer.write("items", 1, { transform: matrix(4) });
  producer.remove("items", 1);
  producer.write("items", 1, item(0, 2, 7));
  const later = producer.changesSince(ack)!;
  assertEquals(later.tables[0]!.upserts[0]!.full, true);
  replica.apply(wire(later));
  ack = producer.tick;
  assertSameState(producer, replica);

  // Created and removed within the range: the consumer never hears of it.
  producer.write("items", 5, item());
  producer.remove("items", 5);
  const delta = producer.changesSince(ack)!;
  assertEquals(delta.tables, []);
  replica.apply(wire(delta));
  ack = producer.tick;

  // Existed, then removed, re-created and removed again in one transaction: a remove.
  producer.transaction(() => {
    producer.remove("items", 1);
    producer.write("items", 1, item());
    producer.remove("items", 1);
  });
  const removal = producer.changesSince(ack)!;
  assertEquals(removal.tables[0]!.removes, [1]);
  replica.apply(wire(removal));
  assertSameState(producer, replica);
});

Deno.test("a truncated journal sends the consumer to a snapshot", () => {
  const store = new SceneStore();
  store.write("items", 1, item());
  const old = store.tick;
  store.write("items", 1, { transform: matrix(3) });
  store.truncateJournal(store.tick);
  assertEquals(store.changesSince(old), null);
  assertEquals(store.journalLength(), 0);
  assert(store.changesSince(store.tick) != null);
});

Deno.test("a replica rejects a delta that does not follow its state", () => {
  const producer = new SceneStore();
  const replica = new SceneStore();
  producer.write("items", 1, item());
  const first = producer.changesSince(0)!;
  producer.write("items", 1, { transform: matrix(1) });
  const second = producer.changesSince(first.toTick)!;
  assertThrows(() => replica.apply(second), StoreDivergence);
  replica.apply(first);
  replica.apply(second);
  assertSameState(producer, replica);
});

Deno.test("a corrupted value is caught by the state hash", () => {
  const producer = new SceneStore();
  const replica = new SceneStore();
  producer.write("items", 1, item());
  const delta = wire(producer.changesSince(0)!);
  (delta.tables[0]!.upserts[0]!.values[1] as Float64Array)[12] = 9;
  assertThrows(() => replica.apply(delta), StoreDivergence, "hash");
});

Deno.test("the codec round-trips values and aligns typed arrays", () => {
  const store = new SceneStore();
  store.write("geometries", 3, {
    data: {
      topology: "triangles",
      attributes: {
        position: { itemSize: 3, normalized: false, array: new Float32Array([0, 1, 2, 3, 4, 5]) },
        color: { itemSize: 4, normalized: true, array: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      },
      index: new Uint16Array([0, 1, 1]),
      bounds: { center: [0.5, -0, 1e300], radius: Number.NaN },
    },
  });
  store.write("items", 1, { ...item(), data: { text: "héllo ✓", n: -(2 ** 31), big: 2 ** 40 } });
  const bytes = encodeDelta(store.snapshot());
  // An unaligned copy must decode too.
  const shifted = new Uint8Array(bytes.byteLength + 3);
  shifted.set(bytes, 3);
  for (const input of [bytes, shifted.subarray(3)]) {
    const replica = new SceneStore();
    replica.apply(decodeDelta(input));
    assertSameState(store, replica);
    const geometry = replica.get("geometries", 3)!.data;
    assertEquals(geometry.attributes.position!.array.constructor, Float32Array);
    assert(Object.is(geometry.bounds!.center[1], -0));
  }
});

Deno.test("randomized: deltas over a lossy link always reproduce the producer", () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const pickInt = (n: number) => Math.floor(random() * n);

  for (let run = 0; run < 20; run++) {
    const producer = new SceneStore();
    const replica = new SceneStore();
    let acked = 0;
    let snapshots = 0, deltas = 0, drops = 0;
    for (let step = 0; step < 300; step++) {
      // A burst of random writes, some of them no-ops.
      producer.transaction(() => {
        const writes = pickInt(6);
        for (let w = 0; w < writes; w++) {
          const table: TableName = random() < 0.8 ? "items" : "nodes";
          const id = 1 + pickInt(12);
          const r = random();
          if (r < 0.15) {
            producer.remove(table, id);
          } else if (table === "nodes") {
            producer.write("nodes", id, {
              structure: { parent: 0, tracked: random() < 0.3 ? "left-grip" : null },
              transform: matrix(pickInt(3)),
            });
          } else if (!producer.has("items", id) || r < 0.3) {
            producer.write("items", id, item(pickInt(3), pickInt(3), pickInt(3)));
          } else if (r < 0.7) {
            producer.write("items", id, { transform: matrix(pickInt(4)) });
          } else {
            producer.write("items", id, { state: { visible: random() < 0.5, layerMask: 1, order: pickInt(2), depthSorted: false } });
          }
        }
      });
      // The journal is kept only back to the consumer's ack, sometimes less.
      if (random() < 0.05) producer.truncateJournal(producer.tick);
      else producer.truncateJournal(acked);

      const delta = producer.changesSince(acked) ?? producer.snapshot();
      if (random() < 0.3) {
        drops++;
        continue; // lost: no apply, no ack
      }
      if (delta.snapshot) snapshots++;
      else deltas++;
      replica.apply(wire(delta));
      acked = delta.toTick;
      assertSameState(producer, replica);
    }
    assert(snapshots > 0 && deltas > 0 && drops > 0, "the run exercised every path");
  }
});

Deno.test("the extraction writer commits nothing for an unchanged scene", () => {
  const store = new SceneStore();
  const writer = new ExtractionStoreWriter(store);
  const world = matrix(1);
  const result = {
    assets: {
      geometries: [{
        id: 10,
        topology: "triangles",
        revision: 1,
        attributes: {
          position: { itemSize: 3, count: 3, normalized: false, componentType: "f32", array: new Float32Array(9) },
        },
      }],
      materials: [{
        id: 20,
        revision: 1,
        kind: "unlit",
        baseColor: [1, 0, 0, 1],
        opacity: 1,
        textures: [],
        uniforms: {},
        state: { transparent: false, depthWrite: true, depthTest: true, colorWrite: true, cullMode: "back", blendMode: "opaque", wireframe: false },
        debugLabel: "red",
      }],
      textures: [],
    },
    frame: {
      camera: {} as never,
      lights: [{ id: 7, type: "directional", color: [1, 1, 1], intensity: 1, position: [0, 2, 0], direction: [0, -1, 0] }],
      instances: [{
        kind: "mesh",
        nodeId: 3,
        geometryId: 10,
        materialId: 20,
        worldMatrix: world,
        normalMatrix: new Float64Array(9),
        renderOrder: 0,
        layerMask: 1,
        transparent: false,
        receiveShadow: false,
        castShadow: false,
      }],
    },
    warnings: [],
  } as unknown as ExtractionResult;

  writer.write(result);
  const tick = store.tick;
  assertEquals(store.size("items"), 1);
  // The next frame: assets are a delta (empty), the lowerer reuses the same matrix buffer.
  const next = { ...result, assets: { geometries: [], materials: [], textures: [] } };
  writer.write(next);
  assertEquals(store.tick, tick);

  world[12] = 2;
  writer.write(next);
  const delta = store.changesSince(tick)!;
  assertEquals(delta.tables.map((t) => t.table), ["items"]);
  assertEquals(delta.tables[0]!.upserts[0]!.mask, 1 << GROUPS.items.indexOf("transform"));

  writer.write({ ...next, frame: { ...next.frame, instances: [], lights: [] } });
  assertEquals(store.size("items"), 0);
  assertEquals(store.size("lights"), 0);
});
