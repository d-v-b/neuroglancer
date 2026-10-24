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

/** What an AudioDecoder needs to know of an MP3 stream, from a frame's
 * header: its sample rate, its channels, and the samples a frame decodes to
 * for each channel. */
export interface Mp3Stream {
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
}

// by the header's version bits (00 MPEG-2.5, 10 MPEG-2, 11 MPEG-1; 01 is
// reserved), then its sample rate index (3 is invalid)
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

/** The stream of a Layer III frame, from its 4-byte header (refkv's
 * spec/virtualize/mp3.md, section 2
 * <https://github.com/d-v-b/refkv/blob/main/spec/virtualize/mp3.md#2-frames>). */
export function mp3Stream(frame: Uint8Array): Mp3Stream {
  if (frame.length < 4 || frame[0] !== 0xff || (frame[1] & 0xe0) !== 0xe0) {
    throw new Error("refkv.stream: an mp3 frame does not start with a sync");
  }
  const version = (frame[1] >> 3) & 3;
  const layer = (frame[1] >> 1) & 3;
  const rateIndex = (frame[2] >> 2) & 3;
  const rates = MP3_SAMPLE_RATES[version];
  if (rates === undefined) {
    throw new Error("refkv.stream: an mp3 frame's version is reserved");
  }
  if (layer !== 1) {
    throw new Error(
      `refkv.stream: an mp3 frame is ${layer === 0 ? "of a reserved layer" : `Layer ${"I".repeat(4 - layer)}`}, not Layer III`,
    );
  }
  if (rateIndex === 3) {
    throw new Error(
      "refkv.stream: an mp3 frame's sample rate index is invalid",
    );
  }
  return {
    sampleRate: rates[rateIndex],
    channels: frame[3] >> 6 === 3 ? 1 : 2,
    samplesPerFrame: version === 3 ? 1152 : 576,
  };
}

/** The H.273 matrix codes a VideoColorSpace names. */
const MATRICES: Record<number, string> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020-ncl",
};

/** An H.264 stream's color signaling, from its first SPS's VUI (H.264 E.1):
 * full range or not (limited when the VUI does not say), and its matrix, if it
 * names one this reader knows. */
export interface StreamColor {
  fullRange: boolean;
  matrix?: string;
}

class Bits {
  private at = 0;
  constructor(private b: Uint8Array) {}
  bit() {
    if (this.at >= this.b.length * 8) {
      throw new Error("refkv.stream: the SPS ends early");
    }
    const v = (this.b[this.at >> 3] >> (7 - (this.at & 7))) & 1;
    ++this.at;
    return v;
  }
  bits(n: number) {
    let v = 0;
    for (let i = 0; i < n; ++i) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31)
        throw new Error("refkv.stream: an SPS code is too long");
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -k / 2;
  }
}

/** The color signaling of the stream whose avcC payload is `avcc`. */
export function streamColor(avcc: Uint8Array): StreamColor {
  const limited: StreamColor = { fullRange: false };
  if (avcc.length < 8 || (avcc[5] & 0x1f) === 0) return limited;
  const length = (avcc[6] << 8) | avcc[7];
  const nal = avcc.subarray(8, 8 + length);
  // the RBSP: the NAL unit's payload without its emulation prevention bytes
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; ++i) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
      continue;
    }
    rbsp.push(nal[i]);
  }
  const r = new Bits(Uint8Array.from(rbsp));
  const profile = r.bits(8);
  r.bits(16); // constraint flags and level
  r.ue(); // seq_parameter_set_id
  if (
    [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
      profile,
    )
  ) {
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); ++i) {
        if (!r.bit()) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64) && next !== 0; ++j) {
          next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; ++i) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit();
  r.ue();
  r.ue();
  if (!r.bit()) r.bit(); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
  r.bit();
  if (r.bit()) for (let i = 0; i < 4; ++i) r.ue(); // frame cropping
  if (!r.bit()) return limited; // vui_parameters_present_flag
  if (r.bit() && r.bits(8) === 255) r.bits(32); // aspect ratio
  if (r.bit()) r.bit(); // overscan
  if (!r.bit()) return limited; // video_signal_type_present_flag
  r.bits(3);
  const fullRange = r.bit() === 1;
  if (!r.bit()) return { fullRange };
  r.bits(16); // colour primaries, transfer characteristics
  const matrix = MATRICES[r.bits(8)];
  return matrix === undefined ? { fullRange } : { fullRange, matrix };
}

/** Converts a picture's full-range Y, U and V (a decoder's output for a
 * limited-range stream, as WebKit's VideoDecoder gives them) back to limited
 * range, in place, at `position` of the chunk: not exactly, since the
 * expansion rounded and clipped. */
export function narrowRange(out: ChunkPlanes, position: number) {
  const { y, u, v } = out.data as Record<Plane, Uint8Array>;
  const [h, w] = out.shapes.y;
  const [ch, cw] = out.shapes.u;
  for (let i = position * h * w, e = i + h * w; i < e; ++i) {
    y[i] = Math.round(16 + (y[i] * 219) / 255);
  }
  for (const c of [u, v]) {
    for (let i = position * ch * cw, e = i + ch * cw; i < e; ++i) {
      c[i] = Math.round(128 + ((c[i] - 128) * 224) / 255);
    }
  }
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

/** A decoded picture's color space, as a VideoFrame gives it. */
export interface ColorLike {
  matrix?: string | null;
  fullRange?: boolean | null;
}

/** The pixel formats of a picture a decoder has converted to RGB (Firefox's
 * VideoDecoder gives BGRX), with each one's red, green and blue byte. */
const RGB_FORMATS: Record<string, [number, number, number]> = {
  BGRX: [2, 1, 0],
  BGRA: [2, 1, 0],
  RGBX: [0, 1, 2],
  RGBA: [0, 1, 2],
};

/** Kr and Kb of a matrix (H.273), BT.601's for an unknown one. */
function lumaWeights(matrix: string | null | undefined): [number, number] {
  switch (matrix) {
    case "bt709":
      return [0.2126, 0.0722];
    case "bt2020-ncl":
      return [0.2627, 0.0593];
    default:
      return [0.299, 0.114];
  }
}

/** Whether a picture in `format` holds its decoder's Y, U and V exactly
 * (8-bit 4:2:0), rather than RGB converted from them. */
export function isExactFormat(format: string) {
  return format === "I420" || format === "I420A" || format === "NV12";
}

/** Converts an RGB picture back to Y, U and V by its color space (BT.601 and
 * limited range when it gives none), the chroma of each 2 x 2 block the mean
 * of its pixels'. The decoder's own values are not recoverable: a value that
 * the conversion to RGB clipped (luma below 16 in limited range) or rounded
 * comes back a few levels off. */
function convertRgb(
  [ri, gi, bi]: [number, number, number],
  src: Uint8Array,
  { offset, stride }: PlaneLayoutLike,
  out: ChunkPlanes,
  position: number,
  color: ColorLike,
) {
  const [kr, kb] = lumaWeights(color.matrix);
  const kg = 1 - kr - kb;
  const full = color.fullRange === true;
  const [yScale, yOffset, cScale] = full ? [255, 0, 255] : [219, 16, 224];
  const [h, w] = out.shapes.y;
  const [ch, cw] = out.shapes.u;
  const { y, u, v } = out.data as Record<Plane, Uint8Array>;
  const cb = new Float64Array(ch * cw);
  const cr = new Float64Array(ch * cw);
  const n = new Float64Array(ch * cw);
  const clamp = (x: number) => Math.min(255, Math.max(0, Math.round(x)));
  const yBase = position * h * w;
  for (let r = 0; r < h; ++r) {
    const row = offset + r * stride;
    for (let c = 0; c < w; ++c) {
      const p = row + 4 * c;
      const R = src[p + ri] / 255;
      const G = src[p + gi] / 255;
      const B = src[p + bi] / 255;
      const luma = kr * R + kg * G + kb * B;
      y[yBase + r * w + c] = clamp(yOffset + yScale * luma);
      const k = (r >> 1) * cw + (c >> 1);
      cb[k] += (B - luma) / (2 * (1 - kb));
      cr[k] += (R - luma) / (2 * (1 - kr));
      n[k] += 1;
    }
  }
  const cBase = position * ch * cw;
  for (let k = 0; k < ch * cw; ++k) {
    u[cBase + k] = clamp(128 + (cScale * cb[k]) / n[k]);
    v[cBase + k] = clamp(128 + (cScale * cr[k]) / n[k]);
  }
}

/** Copies a decoded picture, `src` with the plane layouts `layout` in the
 * pixel format `format`, into the chunk's planes at `position`: 8-bit 4:2:0
 * ("I420", "I420A" or "NV12") as it is, and RGB ("BGRX", "BGRA", "RGBX",
 * "RGBA") converted back by its color space `color` (see `convertRgb`). */
export function copyPicture(
  format: string,
  src: Uint8Array,
  layout: readonly PlaneLayoutLike[],
  out: ChunkPlanes,
  position: number,
  color: ColorLike = {},
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
  } else if (format in RGB_FORMATS) {
    convertRgb(RGB_FORMATS[format], src, layout[0], out, position, color);
  } else {
    throw new Error(
      `refkv.stream: an H.264 picture decodes to ${format}, not 8-bit 4:2:0 or RGB`,
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
