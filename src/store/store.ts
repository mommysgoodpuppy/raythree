/**
 * The scene store: retained tables written by one producer, replicated to any number of
 * renderers. See `markdown/scene-stream/README.md` in PetPlay for the design.
 *
 * - Writes compare before they mark: an equal value changes nothing.
 * - Each committed transaction advances `tick` and appends one journal entry per touched row
 *   (deduplicated within the transaction). The journal indexes the current state; it never holds
 *   values. `changesSince(n)` reads the journal range (n, tick], so its cost is proportional to
 *   what changed, not to the store's size.
 * - The state hash is maintained incrementally (XOR of per-group hashes mixed with their address)
 *   and travels with every delta, so a replica detects divergence without rescanning.
 * - A replica is the same class: `apply(delta)` writes through the same path, so the replica's
 *   own journal and listeners see exactly the rows that changed.
 */
import {
  allGroupsMask,
  GROUPS,
  type GroupName,
  identityMatrix,
  type Row,
  type RowId,
  type TableName,
  TABLES,
  WORLD_NODE,
} from "./schema.ts";
import { copyValue, type Hash, hashValue, mixAddress, valuesEqual } from "./values.ts";

/** Journal entry flags, above any group bit. */
const REMOVED = 1 << 29;
/** The row existed when the entry was opened: a consumer at the previous tick has it. */
const EXISTED = 1 << 28;
const GROUP_BITS = (1 << 28) - 1;

interface RowRecord {
  values: unknown[];
  hashes: Hash[];
  /** Tick at which each group last changed. */
  ticks: number[];
}

export interface TouchedRow {
  table: TableName;
  id: RowId;
  /** Groups that changed (all groups for a new row); 0 with `removed`. */
  mask: number;
  removed: boolean;
}

export interface DeltaRow {
  id: RowId;
  mask: number;
  /** The consumer may not have this row: `values` holds every group. */
  full: boolean;
  /** Values of the groups in `mask`, in group order. */
  values: unknown[];
}

export interface DeltaTable {
  table: TableName;
  upserts: DeltaRow[];
  removes: RowId[];
}

export interface SceneDelta {
  version: 1;
  /** A snapshot replaces the replica's whole state; a delta applies on top of `fromTick`. */
  snapshot: boolean;
  fromTick: number;
  toTick: number;
  /** Producer state hash at `toTick`. */
  hash: Hash;
  tables: DeltaTable[];
}

export class StoreDivergence extends Error {
  override name = "StoreDivergence";
}

type Listener = (touched: TouchedRow[], tick: number) => void;

export class SceneStore {
  /** Last committed tick. */
  tick = 0;
  /** For a replica: the producer tick its state equals. */
  sourceTick = 0;

  private readonly rows: Map<RowId, RowRecord>[] = TABLES.map(() => new Map());
  private hashA = 0;
  private hashB = 0;

  private readonly jTick: number[] = [];
  private readonly jTable: number[] = [];
  private readonly jId: number[] = [];
  private readonly jMask: number[] = [];
  /** `changesSince(n)` answers for any n ≥ floor. */
  private journalFloor = 0;

  private depth = 0;
  private readonly open = new Map<number, number>(); // address → journal index, this transaction
  private readonly listeners = new Set<Listener>();

  constructor() {
    // Every store, producer or replica, starts with the world root at tick 0.
    this.insert(TABLES.indexOf("nodes"), WORLD_NODE, [
      { parent: null, tracked: null },
      identityMatrix(),
    ], 0);
  }

  // ---- reading ----

  has(table: TableName, id: RowId): boolean {
    return this.rows[TABLES.indexOf(table)]!.has(id);
  }

  /** The stored row. Its values belong to the store: read, never mutate. */
  get<T extends TableName>(table: T, id: RowId): Readonly<Row<T>> | undefined {
    const record = this.rows[TABLES.indexOf(table)]!.get(id);
    if (!record) return undefined;
    const out: Record<string, unknown> = {};
    GROUPS[table].forEach((group, g) => out[group] = record.values[g]);
    return out as unknown as Row<T>;
  }

  ids(table: TableName): IterableIterator<RowId> {
    return this.rows[TABLES.indexOf(table)]!.keys();
  }

  size(table: TableName): number {
    return this.rows[TABLES.indexOf(table)]!.size;
  }

  changedTick<T extends TableName>(table: T, id: RowId, group: GroupName<T>): number | undefined {
    const g = (GROUPS[table] as readonly string[]).indexOf(group);
    return this.rows[TABLES.indexOf(table)]!.get(id)?.ticks[g];
  }

  hash(): Hash {
    return [this.hashA >>> 0, this.hashB >>> 0];
  }

  onTransaction(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- writing ----

  /** Groups writes into one tick. Nested calls join the outer transaction. */
  transaction<R>(fn: () => R): R {
    this.depth++;
    const start = this.jTick.length;
    try {
      return fn();
    } finally {
      if (--this.depth === 0) this.commit(start);
    }
  }

  /**
   * Writes some or all groups of a row. A new row needs every group. Returns whether anything
   * changed. Values are copied when they change, so callers may reuse their buffers.
   */
  write<T extends TableName>(table: T, id: RowId, groups: Partial<Row<T>>): boolean {
    return this.transaction(() => this.writeGroups(TABLES.indexOf(table), id, groups, true));
  }

  remove(table: TableName, id: RowId): boolean {
    if (table === "nodes" && id === WORLD_NODE) throw new Error("The world node cannot be removed");
    return this.transaction(() => this.removeRow(TABLES.indexOf(table), id));
  }

  // ---- deltas ----

  /** Everything changed since `fromTick`, or null if the journal no longer reaches back that far. */
  changesSince(fromTick: number): SceneDelta | null {
    if (fromTick < this.journalFloor || fromTick > this.tick) return null;
    type Merged = { mask: number; firstExisted: boolean; removed: boolean };
    const merged = TABLES.map(() => new Map<RowId, Merged>());
    for (let i = this.firstEntryAfter(fromTick); i < this.jTick.length; i++) {
      const rows = merged[this.jTable[i]!]!;
      const id = this.jId[i]!, mask = this.jMask[i]!;
      const m = rows.get(id);
      if (m) {
        m.mask |= mask & GROUP_BITS;
        m.removed ||= (mask & REMOVED) !== 0;
      } else {
        rows.set(id, {
          mask: mask & GROUP_BITS,
          firstExisted: (mask & EXISTED) !== 0,
          removed: (mask & REMOVED) !== 0,
        });
      }
    }
    const tables: DeltaTable[] = [];
    merged.forEach((rows, t) => {
      if (rows.size === 0) return;
      const table = TABLES[t]!;
      const out: DeltaTable = { table, upserts: [], removes: [] };
      for (const [id, m] of rows) {
        const record = this.rows[t]!.get(id);
        if (!record) {
          if (m.firstExisted) out.removes.push(id);
          continue;
        }
        const full = !m.firstExisted || m.removed;
        const mask = full ? allGroupsMask(table) : m.mask;
        if (mask === 0) continue;
        out.upserts.push({ id, mask, full, values: pick(record.values, mask) });
      }
      if (out.upserts.length || out.removes.length) tables.push(out);
    });
    return { version: 1, snapshot: false, fromTick, toTick: this.tick, hash: this.hash(), tables };
  }

  /** The whole state, for a new or diverged consumer. */
  snapshot(): SceneDelta {
    const tables: DeltaTable[] = [];
    this.rows.forEach((rows, t) => {
      const table = TABLES[t]!;
      const all = allGroupsMask(table);
      const upserts: DeltaRow[] = [];
      for (const [id, record] of rows) {
        upserts.push({ id, mask: all, full: true, values: record.values.slice() });
      }
      tables.push({ table, upserts, removes: [] });
    });
    return { version: 1, snapshot: true, fromTick: 0, toTick: this.tick, hash: this.hash(), tables };
  }

  /** Drops journal entries at or below `tick`; consumers acked below it need a snapshot. */
  truncateJournal(tick: number): void {
    const n = this.firstEntryAfter(Math.min(tick, this.tick));
    this.jTick.splice(0, n);
    this.jTable.splice(0, n);
    this.jId.splice(0, n);
    this.jMask.splice(0, n);
    this.journalFloor = Math.max(this.journalFloor, Math.min(tick, this.tick));
  }

  journalLength(): number {
    return this.jTick.length;
  }

  /**
   * Replica side: applies a producer delta or snapshot as one transaction. Throws
   * {@link StoreDivergence} when the delta does not follow this replica's state or the resulting
   * hash disagrees; the caller should then ask for a snapshot.
   */
  apply(delta: SceneDelta): void {
    if (delta.version !== 1) throw new StoreDivergence(`Unknown delta version ${delta.version}`);
    if (!delta.snapshot && delta.fromTick !== this.sourceTick) {
      throw new StoreDivergence(`Delta from ${delta.fromTick}, replica at ${this.sourceTick}`);
    }
    const byTable = new Map(delta.tables.map((t) => [t.table, t]));
    this.transaction(() => {
      // Removes in reverse dependency order, then upserts in dependency order.
      for (let t = TABLES.length - 1; t >= 0; t--) {
        const entry = byTable.get(TABLES[t]!);
        const rows = this.rows[t]!;
        if (delta.snapshot) {
          const keep = new Set(entry?.upserts.map((row) => row.id));
          for (const id of [...rows.keys()]) if (!keep.has(id)) this.removeRow(t, id);
        }
        for (const id of entry?.removes ?? []) this.removeRow(t, id);
      }
      for (let t = 0; t < TABLES.length; t++) {
        const entry = byTable.get(TABLES[t]!);
        const groups = GROUPS[TABLES[t]!];
        for (const row of entry?.upserts ?? []) {
          const exists = this.rows[t]!.has(row.id);
          if (!exists && !row.full) {
            throw new StoreDivergence(`${TABLES[t]} ${row.id}: partial update to a missing row`);
          }
          const values: Record<string, unknown> = {};
          let v = 0;
          for (let g = 0; g < groups.length; g++) {
            if (row.mask & (1 << g)) values[groups[g]!] = row.values[v++];
          }
          // Decoded values are fresh, so the replica adopts them instead of copying.
          this.writeGroups(t, row.id, values, false);
        }
      }
    });
    this.sourceTick = delta.toTick;
    const [a, b] = this.hash();
    if (a !== delta.hash[0] || b !== delta.hash[1]) {
      throw new StoreDivergence(`State hash mismatch at producer tick ${delta.toTick}`);
    }
  }

  // ---- internals ----

  private writeGroups(
    t: number,
    id: RowId,
    groups: Record<string, unknown>,
    copy: boolean,
  ): boolean {
    const names = GROUPS[TABLES[t]!] as readonly string[];
    const record = this.rows[t]!.get(id);
    if (!record) {
      const values = names.map((name) => {
        if (!(name in groups)) throw new Error(`New ${TABLES[t]} row ${id} is missing "${name}"`);
        return copy ? copyValue(groups[name]) : groups[name];
      });
      this.insert(t, id, values, this.tick + 1);
      this.mark(t, id, allGroupsMask(TABLES[t]!), false);
      return true;
    }
    let mask = 0;
    for (const [name, value] of Object.entries(groups)) {
      const g = names.indexOf(name);
      if (g < 0) throw new Error(`${TABLES[t]} has no group "${name}"`);
      const hash = hashValue(value);
      const old = record.hashes[g]!;
      if (old[0] === hash[0] && old[1] === hash[1] && valuesEqual(record.values[g], value)) {
        continue;
      }
      this.xorHash(mixAddress(t, id, g, old));
      this.xorHash(mixAddress(t, id, g, hash));
      record.values[g] = copy ? copyValue(value) : value;
      record.hashes[g] = hash;
      record.ticks[g] = this.tick + 1;
      mask |= 1 << g;
    }
    if (mask !== 0) this.mark(t, id, mask, true);
    return mask !== 0;
  }

  private insert(t: number, id: RowId, values: unknown[], tick: number): void {
    const hashes = values.map(hashValue);
    hashes.forEach((hash, g) => this.xorHash(mixAddress(t, id, g, hash)));
    this.rows[t]!.set(id, { values, hashes, ticks: values.map(() => tick) });
  }

  private removeRow(t: number, id: RowId): boolean {
    const record = this.rows[t]!.get(id);
    if (!record) return false;
    record.hashes.forEach((hash, g) => this.xorHash(mixAddress(t, id, g, hash)));
    this.rows[t]!.delete(id);
    this.mark(t, id, REMOVED, true);
    return true;
  }

  /** Opens or extends this transaction's journal entry for a row. */
  private mark(t: number, id: RowId, mask: number, existed: boolean): void {
    const address = t * 0x1_0000_0000 + id;
    const open = this.open.get(address);
    if (open !== undefined) {
      // A remove clears the groups written before it; a write after a remove is a new row.
      const prev = this.jMask[open]!;
      this.jMask[open] = mask & REMOVED
        ? (prev & EXISTED) | REMOVED
        : (prev & (EXISTED | REMOVED)) | (prev & GROUP_BITS) | mask;
      return;
    }
    this.open.set(address, this.jTick.length);
    this.jTick.push(this.tick + 1);
    this.jTable.push(t);
    this.jId.push(id);
    this.jMask.push(mask | (existed ? EXISTED : 0));
  }

  /**
   * A transaction that threw still commits what it wrote: each write left a consistent row, and
   * committing keeps the journal truthful about it.
   */
  private commit(start: number): void {
    this.open.clear();
    if (this.jTick.length === start) return;
    this.tick++;
    if (this.listeners.size === 0) return;
    const touched: TouchedRow[] = [];
    for (let i = start; i < this.jTick.length; i++) {
      const mask = this.jMask[i]!;
      const removed = (mask & REMOVED) !== 0 && !this.rows[this.jTable[i]!]!.has(this.jId[i]!);
      touched.push({
        table: TABLES[this.jTable[i]!]!,
        id: this.jId[i]!,
        mask: removed ? 0 : mask & GROUP_BITS || allGroupsMask(TABLES[this.jTable[i]!]!),
        removed,
      });
    }
    for (const listener of this.listeners) listener(touched, this.tick);
  }

  private firstEntryAfter(tick: number): number {
    let lo = 0, hi = this.jTick.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.jTick[mid]! <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private xorHash(h: Hash): void {
    this.hashA ^= h[0];
    this.hashB ^= h[1];
  }
}

function pick(values: unknown[], mask: number): unknown[] {
  const out: unknown[] = [];
  for (let g = 0; g < values.length; g++) if (mask & (1 << g)) out.push(values[g]);
  return out;
}
