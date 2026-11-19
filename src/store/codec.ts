/**
 * Binary encoding for scene deltas: one slab per delta.
 *
 * Layout: a 24-byte header, a structure region (tagged values), a string table, then an
 * 8-byte-aligned data region holding every typed array's bytes. Decoding returns typed arrays as
 * views into the slab, so large buffers (geometry, matrices) are never copied on the way in.
 */
import type { SceneDelta } from "./store.ts";

const MAGIC = 0x44535452; // "RTSD" little-endian
const VERSION = 1;
const HEADER = 24;

const enum Tag {
  Undefined = 0,
  Null = 1,
  False = 2,
  True = 3,
  F64 = 4,
  String = 5,
  Array = 6,
  Object = 7,
  Typed = 8,
  I32 = 9,
}

const TYPED = [
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
] as const;
type TypedArray = InstanceType<typeof TYPED[number]>;

class Growable {
  bytes = new Uint8Array(1024);
  view = new DataView(this.bytes.buffer);
  length = 0;

  reserve(n: number): number {
    const at = this.length;
    if (at + n > this.bytes.length) {
      let size = this.bytes.length * 2;
      while (size < at + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.bytes.subarray(0, at));
      this.bytes = next;
      this.view = new DataView(next.buffer);
    }
    this.length = at + n;
    return at;
  }

  // Reserve before reading `bytes`/`view`: growing replaces them, and `this.view.set…(this.reserve())`
  // would evaluate the old view first.
  u8(v: number): void {
    const at = this.reserve(1);
    this.bytes[at] = v;
  }

  u32(v: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, v, true);
  }

  i32(v: number): void {
    const at = this.reserve(4);
    this.view.setInt32(at, v, true);
  }

  f64(v: number): void {
    const at = this.reserve(8);
    this.view.setFloat64(at, v, true);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeDelta(delta: SceneDelta): Uint8Array {
  const struct = new Growable();
  const data = new Growable();
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };

  const write = (v: unknown): void => {
    if (v === undefined) return struct.u8(Tag.Undefined);
    if (v === null) return struct.u8(Tag.Null);
    switch (typeof v) {
      case "boolean":
        return struct.u8(v ? Tag.True : Tag.False);
      case "number":
        if (Number.isInteger(v) && v >= -0x8000_0000 && v <= 0x7fff_ffff && !Object.is(v, -0)) {
          struct.u8(Tag.I32);
          return struct.i32(v);
        }
        struct.u8(Tag.F64);
        return struct.f64(v);
      case "string":
        struct.u8(Tag.String);
        return struct.u32(intern(v));
    }
    if (ArrayBuffer.isView(v)) {
      const kind = TYPED.findIndex((T) => v instanceof T && v.constructor === T);
      if (kind < 0) throw new TypeError(`Cannot encode ${v.constructor.name}`);
      const array = v as TypedArray;
      const pad = (8 - (data.length & 7)) & 7;
      data.reserve(pad);
      const at = data.reserve(array.byteLength);
      data.bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
      struct.u8(Tag.Typed);
      struct.u8(kind);
      struct.u32(at);
      struct.u32(array.length);
      return;
    }
    if (Array.isArray(v)) {
      struct.u8(Tag.Array);
      struct.u32(v.length);
      for (const item of v) write(item);
      return;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as object);
      struct.u8(Tag.Object);
      struct.u32(entries.length);
      for (const [key, value] of entries) {
        struct.u32(intern(key));
        write(value);
      }
      return;
    }
    throw new TypeError(`Cannot encode ${typeof v}`);
  };
  write(delta);

  const encodedStrings = strings.map((s) => encoder.encode(s));
  const stringBytes = 4 + encodedStrings.reduce((n, s) => n + 4 + s.byteLength, 0);
  const dataStart = align8(HEADER + struct.length + stringBytes);
  const out = new Uint8Array(dataStart + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, struct.length, true);
  view.setUint32(12, stringBytes, true);
  view.setUint32(16, data.length, true);
  out.set(struct.bytes.subarray(0, struct.length), HEADER);
  let at = HEADER + struct.length;
  view.setUint32(at, strings.length, true);
  at += 4;
  for (const s of encodedStrings) {
    view.setUint32(at, s.byteLength, true);
    out.set(s, at + 4);
    at += 4 + s.byteLength;
  }
  out.set(data.bytes.subarray(0, data.length), dataStart);
  return out;
}

export function decodeDelta(input: Uint8Array): SceneDelta {
  // Typed array views need the data region 8-byte aligned in its buffer.
  const bytes = input.byteOffset & 7 ? input.slice() : input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a scene delta");
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`Unsupported scene delta encoding ${version}`);
  const structLength = view.getUint32(8, true);
  const stringBytes = view.getUint32(12, true);
  const dataLength = view.getUint32(16, true);
  let at = HEADER + structLength;
  const strings: string[] = [];
  const count = view.getUint32(at, true);
  at += 4;
  for (let i = 0; i < count; i++) {
    const n = view.getUint32(at, true);
    strings.push(decoder.decode(bytes.subarray(at + 4, at + 4 + n)));
    at += 4 + n;
  }
  if (at !== HEADER + structLength + stringBytes) throw new Error("Corrupt string table");
  const dataStart = align8(at);
  if (dataStart + dataLength > bytes.byteLength) throw new Error("Truncated scene delta");

  let p = HEADER;
  const end = HEADER + structLength;
  const read = (): unknown => {
    if (p >= end) throw new Error("Truncated structure");
    const tag = view.getUint8(p++);
    switch (tag) {
      case Tag.Undefined:
        return undefined;
      case Tag.Null:
        return null;
      case Tag.False:
        return false;
      case Tag.True:
        return true;
      case Tag.I32:
        return (p += 4, view.getInt32(p - 4, true));
      case Tag.F64:
        return (p += 8, view.getFloat64(p - 8, true));
      case Tag.String:
        return strings[(p += 4, view.getUint32(p - 4, true))];
      case Tag.Typed: {
        const T = TYPED[view.getUint8(p)];
        const offset = view.getUint32(p + 1, true);
        const length = view.getUint32(p + 5, true);
        p += 9;
        if (!T) throw new Error("Unknown typed array kind");
        if (offset + length * T.BYTES_PER_ELEMENT > dataLength) throw new Error("Typed array out of range");
        return new T(bytes.buffer as ArrayBuffer, bytes.byteOffset + dataStart + offset, length);
      }
      case Tag.Array: {
        const n = (p += 4, view.getUint32(p - 4, true));
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = read();
        return out;
      }
      case Tag.Object: {
        const n = (p += 4, view.getUint32(p - 4, true));
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = strings[(p += 4, view.getUint32(p - 4, true))]!;
          out[key] = read();
        }
        return out;
      }
    }
    throw new Error(`Unknown tag ${tag}`);
  };
  const delta = read() as SceneDelta;
  if (p !== end) throw new Error("Trailing structure bytes");
  return delta;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}
