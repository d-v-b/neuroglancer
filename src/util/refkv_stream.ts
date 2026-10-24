/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file What the `refkv.stream` codec needs besides a decoder: a chunk's
 * frames and their output positions, the WebCodecs codec string of an H.264
 * stream, the copy of a decoded picture's planes into a chunk, and the planes
 * a decoding gave that were not asked for yet. A chunk is a varint count `n`,
 * then for each frame a varint size and a zigzag varint of its position less
 * the previous frame's (the first's less -1), then the frames; a frame at
 * position -1 is decoded and dropped (refkv's spec/conventions.md, section 10
 * <https://github.com/d-v-b/refkv/blob/main/spec/conventions.md#10-coded-streams>).
 */

export interface StreamChunk {
  units: Uint8Array<ArrayBuffer>[];
  positions: number[];
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  let scale = 1;
  for (;;) {
    if (at >= b.length || scale > 2 ** 49) {
      throw new Error("refkv.stream: a chunk's header ends inside a varint");
    }
    const c = b[at++];
    v += (c & 0x7f) * scale;
    if (c < 0x80) return [v, at];
    scale *= 128;
  }
}

/** The frames of a `refkv.stream` chunk and their output positions. */
export function parseStreamChunk(b: Uint8Array<ArrayBuffer>): StreamChunk {
  let [n, at] = readVarint(b, 0);
  const sizes: number[] = [];
  const positions: number[] = [];
  let prev = -1;
  for (let i = 0; i < n; ++i) {
    let size: number;
    let z: number;
    [size, at] = readVarint(b, at);
    [z, at] = readVarint(b, at);
    prev += z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    sizes.push(size);
    positions.push(prev);
  }
  const total = sizes.reduce((a, s) => a + s, 0);
  if (at + total !== b.length) {
    throw new Error(
      `refkv.stream: the frames' sizes sum to ${total}, not the chunk's ${b.length - at}`,
    );
  }
  const units = sizes.map((size) => {
    const u = b.subarray(at, at + size);
    at += size;
    return u;
  });
  return { units, positions };
}

/** The WebCodecs codec string of an H.264 stream from its avcC box's payload:
 * `avc1.PPCCLL`, its profile, constraint flags and level. */
export function avcCodecString(avcc: Uint8Array): string {
  if (avcc.length < 4 || avcc[0] !== 1) {
    throw new Error("refkv.stream: the setup is not an avcC box's payload");
  }
  const hex = (x: number) => x.toString(16).padStart(2, "0");
  return `avc1.${hex(avcc[1])}${hex(avcc[2])}${hex(avcc[3])}`;
}

export const PLANES = ["y", "u", "v"] as const;
export type Plane = (typeof PLANES)[number];

/** A chunk's planes: each `frames` pictures of its height and width, row-major. */
export interface ChunkPlanes {
  frames: number;
  shapes: Record<Plane, [number, number]>;
  data: Partial<Record<Plane, Uint8Array<ArrayBuffer>>>;
}

export function newChunkPlanes(
  frames: number,
  width: number,
  height: number,
): ChunkPlanes {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  return {
    frames,
    shapes: { y: [height, width], u: [ch, cw], v: [ch, cw] },
    data: {
      y: new Uint8Array(frames * width * height),
      u: new Uint8Array(frames * cw * ch),
      v: new Uint8Array(frames * cw * ch),
    },
  };
}

export interface PlaneLayoutLike {
  offset: number;
  stride: number;
}

/** Copies a decoded picture, `src` with the plane layouts `layout` in the
 * pixel format `format` ("I420", "I420A" or "NV12": 8-bit 4:2:0), into the
 * chunk's planes at `position`. */
export function copyPicture(
  format: string,
  src: Uint8Array,
  layout: readonly PlaneLayoutLike[],
  out: ChunkPlanes,
  position: number,
) {
  if (position < 0 || position >= out.frames) {
    throw new Error(
      `refkv.stream: a picture at ${position} is outside the chunk's ${out.frames}`,
    );
  }
  const copyRows = (
    from: PlaneLayoutLike,
    to: Uint8Array,
    [h, w]: [number, number],
  ) => {
    const base = position * h * w;
    for (let r = 0; r < h; ++r) {
      const s = from.offset + r * from.stride;
      to.set(src.subarray(s, s + w), base + r * w);
    }
  };
  const { y, u, v } = out.data as Record<Plane, Uint8Array>;
  if (format === "I420" || format === "I420A") {
    copyRows(layout[0], y, out.shapes.y);
    copyRows(layout[1], u, out.shapes.u);
    copyRows(layout[2], v, out.shapes.v);
  } else if (format === "NV12") {
    copyRows(layout[0], y, out.shapes.y);
    const [h, w] = out.shapes.u;
    const base = position * h * w;
    const { offset, stride } = layout[1];
    for (let r = 0; r < h; ++r) {
      let s = offset + r * stride;
      let d = base + r * w;
      for (let c = 0; c < w; ++c, s += 2, ++d) {
        u[d] = src[s];
        v[d] = src[s + 1];
      }
    }
  } else {
    throw new Error(
      `refkv.stream: an H.264 picture decodes to ${format}, not 8-bit 4:2:0`,
    );
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}

function fnv1a(b: Uint8Array) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; ++i) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Entry {
  key: string;
  setup: string;
  bytes: Uint8Array;
  planes: Promise<ChunkPlanes>;
  done?: ChunkPlanes;
}

function heldBytes(planes: ChunkPlanes | undefined) {
  let n = 0;
  for (const d of Object.values(planes?.data ?? {})) n += d!.byteLength;
  return n;
}

/** The planes a video chunk's decoding gave that were not asked for yet, kept
 * for when they are: a chunk's Y, U and V are one chunk's bytes, so reading
 * them decodes it once. A plane is given once; at most `limit` bytes are kept,
 * the oldest chunk dropped first. While a chunk decodes, a request for another
 * of its planes waits for that decoding. */
export class SharedPlanes {
  private entries = new Map<string, Entry[]>();
  private order: Entry[] = [];

  constructor(private limit: number) {}

  /** The plane `plane` of the chunk `bytes` of the stream `setup`: kept, or
   * decoded by `decode`, which gives every plane. */
  async take(
    setup: string,
    bytes: Uint8Array,
    plane: Plane,
    decode: () => Promise<ChunkPlanes>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const key = `${bytes.length}:${fnv1a(bytes)}`;
    const found = this.entries
      .get(key)
      ?.find((e) => e.setup === setup && sameBytes(e.bytes, bytes));
    if (found !== undefined) {
      const decoded = await found.planes;
      const data = decoded.data[plane];
      if (data !== undefined) {
        delete decoded.data[plane];
        if (heldBytes(decoded) === 0) this.drop(found);
        return data;
      }
      this.drop(found);
    }
    const entry: Entry = { key, setup, bytes, planes: decode() };
    this.entries.set(key, [...(this.entries.get(key) ?? []), entry]);
    this.order.push(entry);
    let decoded: ChunkPlanes;
    try {
      decoded = await entry.planes;
    } catch (e) {
      this.drop(entry);
      throw e;
    }
    const data = decoded.data[plane];
    if (data === undefined) {
      this.drop(entry);
      throw new Error(`refkv.stream: the chunk has no ${plane} plane`);
    }
    delete decoded.data[plane];
    entry.done = decoded;
    const kept = heldBytes(decoded);
    if (kept === 0 || kept > this.limit) {
      this.drop(entry);
    } else {
      while (this.bytes() > this.limit) this.drop(this.order[0]);
    }
    return data;
  }

  /** The bytes of the planes kept. */
  bytes() {
    return this.order.reduce((n, e) => n + heldBytes(e.done), 0);
  }

  /** The count of chunks whose planes are kept or decoding. */
  get size() {
    return this.order.length;
  }

  private drop(entry: Entry) {
    const list = this.entries.get(entry.key)?.filter((e) => e !== entry) ?? [];
    if (list.length === 0) this.entries.delete(entry.key);
    else this.entries.set(entry.key, list);
    this.order = this.order.filter((e) => e !== entry);
  }
}
