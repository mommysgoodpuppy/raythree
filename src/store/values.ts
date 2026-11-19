/**
 * Structural hashing, equality and copying for store values: plain objects, arrays, strings,
 * numbers, booleans, null, and typed arrays. Nothing else may be written to the store.
 */

/** Two independent 32-bit lanes; together a 64-bit hash. */
export type Hash = readonly [number, number];

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Hasher {
  a = 0x811c9dc5;
  b = 0x9e3779b9;

  word(w: number): void {
    this.a = Math.imul(this.a ^ w, 0x01000193);
    this.b = Math.imul(this.b ^ w, 0x85ebca6b) ^ (this.b >>> 13);
  }

  number(n: number): void {
    f64[0] = n;
    this.word(u32[0]!);
    this.word(u32[1]!);
  }

  string(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  value(v: unknown): void {
    if (v === undefined) return this.word(0x10);
    if (v === null) return this.word(0x11);
    switch (typeof v) {
      case "boolean":
        return this.word(v ? 0x12 : 0x13);
      case "number":
        this.word(0x14);
        return this.number(v);
      case "string":
        this.word(0x15);
        return this.string(v);
    }
    if (ArrayBuffer.isView(v)) {
      const view = v as unknown as ArrayLike<number> & ArrayBufferView;
      this.word(0x16);
      this.string(v.constructor.name);
      this.word(view.length);
      // Hash the bytes: exact for every element type, and four bytes per word is cheap.
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const words = bytes.byteLength >>> 2;
      if ((view.byteOffset & 3) === 0) {
        const w = new Uint32Array(view.buffer, view.byteOffset, words);
        for (let i = 0; i < words; i++) this.word(w[i]!);
      } else {
        for (let i = 0; i < words; i++) {
          const o = i << 2;
          this.word(bytes[o]! | bytes[o + 1]! << 8 | bytes[o + 2]! << 16 | bytes[o + 3]! << 24);
        }
      }
      for (let i = words << 2; i < bytes.byteLength; i++) this.word(bytes[i]!);
      return;
    }
    if (Array.isArray(v)) {
      this.word(0x17);
      this.word(v.length);
      for (const item of v) this.value(item);
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object).sort();
      this.word(0x18);
      this.word(keys.length);
      for (const key of keys) {
        this.string(key);
        this.value((v as Record<string, unknown>)[key]);
      }
      return;
    }
    throw new TypeError(`Scene store values cannot be ${typeof v}`);
  }
}

export function hashValue(v: unknown): Hash {
  const h = new Hasher();
  h.value(v);
  return [h.a >>> 0, h.b >>> 0];
}

/** Mixes a group hash with its address, so the same value in two rows contributes differently. */
export function mixAddress(table: number, id: number, group: number, hash: Hash): Hash {
  const h = new Hasher();
  h.word(table);
  h.word(id);
  h.word(group);
  h.word(hash[0]);
  h.word(hash[1]);
  return [h.a >>> 0, h.b >>> 0];
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // NaN written twice is the same value.
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    if (a.constructor !== b.constructor) return false;
    const x = a as unknown as ArrayLike<number>, y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i] && !(Number.isNaN(x[i]) && Number.isNaN(y[i]))) return false;
    }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], y[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.hasOwn(b, key)) return false;
    if (!valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/** A copy that shares nothing mutable with `v` (producers reuse their buffers in place). */
export function copyValue<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return (v as unknown as { slice(): T }).slice();
  if (Array.isArray(v)) return v.map(copyValue) as T;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v as object)) out[key] = copyValue(value);
  return out as T;
}
