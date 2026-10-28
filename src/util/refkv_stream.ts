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
 * or HEVC stream, the copy of a decoded picture's planes into a chunk, and the
 * planes a decoding gave that were not asked for yet. A chunk is a varint
 * count `n`, then for each frame a varint size and a zigzag varint of its
 * position less the previous frame's (the first's less -1), then the frames;
 * a frame at position -1 is decoded and dropped (refkv's spec/conventions.md, section 10
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

/** The WebCodecs codec string of an HEVC stream from its hvcC box's payload
 * (ISO/IEC 14496-15 E.3): `hvc1.` (or `hev1.`), then the general profile space
 * (none for 0, else "A" to "C") and profile, the profile compatibility flags
 * in reverse bit order in hex, the tier ("L" or "H") and level, and the
 * constraint flags' bytes in hex, without the trailing zero ones: x265's Main
 * at level 3 is `hvc1.1.6.L30.90`. */
export function hevcCodecString(
  hvcc: Uint8Array,
  entry: "hvc1" | "hev1" = "hvc1",
): string {
  // version 1, and the reserved bits before min_spatial_segmentation_idc and
  // parallelismType set
  if (
    hvcc.length < 23 ||
    hvcc[0] !== 1 ||
    (hvcc[13] & 0xf0) !== 0xf0 ||
    (hvcc[15] & 0xfc) !== 0xfc
  ) {
    throw new Error("refkv.stream: the setup is not an hvcC box's payload");
  }
  const space = hvcc[1] >> 6;
  const tier = (hvcc[1] >> 5) & 1;
  const profile = hvcc[1] & 0x1f;
  // general_profile_compatibility_flag[j], the j-th bit from the first
  // byte's high bit, is bit j of the reversed value
  let reversed = 0;
  for (let j = 0; j < 32; ++j) {
    if ((hvcc[2 + (j >> 3)] >> (7 - (j & 7))) & 1) reversed += 2 ** j;
  }
  const constraints = Array.from(hvcc.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) {
    constraints.pop();
  }
  const hex = (x: number) => x.toString(16).toUpperCase();
  return [
    entry,
    `${["", "A", "B", "C"][space]}${profile}`,
    hex(reversed),
    `${tier ? "H" : "L"}${hvcc[12]}`,
    ...constraints.map(hex),
  ].join(".");
}

/** The general profile of an HEVC stream from its hvcC box's payload, by name
 * when it is Main or Main 10. */
export function hevcProfile(hvcc: Uint8Array): string {
  const profile = hvcc[1] & 0x1f;
  return profile === 1
    ? "Main"
    : profile === 2
      ? "Main 10"
      : `profile ${profile}`;
}

/** The H.273 matrix codes a VideoColorSpace names. */
const MATRICES: Record<number, string> = {
  1: "bt709",
  5: "bt470bg",
  6: "smpte170m",
  9: "bt2020-ncl",
};

/** A stream's color signaling, from its first SPS's VUI (H.264 E.1, H.265
 * E.2): full range or not (limited when the VUI does not say), and its matrix,
 * if it names one this reader knows. */
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

const LIMITED: StreamColor = { fullRange: false };

/** The bits of a NAL unit's payload, after its header of `header` bytes,
 * without its emulation prevention bytes. */
function rbspBits(nal: Uint8Array, header: number) {
  const rbsp: number[] = [];
  for (let i = header; i < nal.length; ++i) {
    if (
      i >= header + 2 &&
      nal[i] === 3 &&
      nal[i - 1] === 0 &&
      nal[i - 2] === 0
    ) {
      continue;
    }
    rbsp.push(nal[i]);
  }
  return new Bits(Uint8Array.from(rbsp));
}

/** The color signaling at the start of an SPS's VUI, whose fields H.264 and
 * HEVC share up to the matrix. */
function vuiColor(r: Bits): StreamColor {
  if (r.bit() && r.bits(8) === 255) r.bits(32); // aspect ratio
  if (r.bit()) r.bit(); // overscan
  if (!r.bit()) return LIMITED; // video_signal_type_present_flag
  r.bits(3);
  const fullRange = r.bit() === 1;
  if (!r.bit()) return { fullRange };
  r.bits(16); // colour primaries, transfer characteristics
  const matrix = MATRICES[r.bits(8)];
  return matrix === undefined ? { fullRange } : { fullRange, matrix };
}

/** The color signaling of the stream whose avcC payload is `avcc`. */
export function streamColor(avcc: Uint8Array): StreamColor {
  if (avcc.length < 8 || (avcc[5] & 0x1f) === 0) return LIMITED;
  const length = (avcc[6] << 8) | avcc[7];
  const r = rbspBits(avcc.subarray(8, 8 + length), 1);
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
  if (!r.bit()) return LIMITED; // vui_parameters_present_flag
  return vuiColor(r);
}

/** The first SPS of an hvcC payload: its arrays follow the 23-byte header,
 * each a NAL unit type, a count and the units, each after its 16-bit size. */
function hevcSps(hvcc: Uint8Array): Uint8Array | undefined {
  let at = 23;
  for (let a = 0; a < (hvcc[22] ?? 0) && at + 3 <= hvcc.length; ++a) {
    const type = hvcc[at] & 0x3f;
    const count = (hvcc[at + 1] << 8) | hvcc[at + 2];
    at += 3;
    for (let k = 0; k < count && at + 2 <= hvcc.length; ++k) {
      const length = (hvcc[at] << 8) | hvcc[at + 1];
      at += 2;
      if (type === 33) return hvcc.subarray(at, at + length);
      at += length;
    }
  }
  return undefined;
}

/** The color signaling of the HEVC stream whose hvcC payload is `hvcc`, from
 * its first SPS (H.265 7.3.2.2.1). */
export function hevcStreamColor(hvcc: Uint8Array): StreamColor {
  const sps = hevcSps(hvcc);
  if (sps === undefined) return LIMITED;
  const r = rbspBits(sps, 2);
  r.bits(4); // sps_video_parameter_set_id
  const subLayers = r.bits(3); // sps_max_sub_layers_minus1
  r.bit();
  // profile_tier_level: the general profile and level, then the sub-layers'
  r.bits(96);
  const present: [number, number][] = [];
  for (let i = 0; i < subLayers; ++i) present.push([r.bit(), r.bit()]);
  if (subLayers > 0) r.bits(2 * (8 - subLayers));
  for (const [profile, level] of present) {
    if (profile) r.bits(88);
    if (level) r.bits(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  if (r.ue() === 3) r.bit(); // chroma_format_idc, separate_colour_plane_flag
  r.ue();
  r.ue();
  if (r.bit()) for (let i = 0; i < 4; ++i) r.ue(); // conformance window
  r.ue(); // bit depths
  r.ue();
  const pocBits = r.ue() + 4; // log2_max_pic_order_cnt_lsb_minus4
  for (let i = r.bit() ? 0 : subLayers; i <= subLayers; ++i) {
    r.ue(); // sub-layer ordering
    r.ue();
    r.ue();
  }
  for (let i = 0; i < 6; ++i) r.ue(); // block sizes and transform depths
  if (r.bit() && r.bit()) {
    // scaling_list_data
    for (let size = 0; size < 4; ++size) {
      for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
        if (!r.bit()) {
          r.ue();
          continue;
        }
        if (size > 1) r.se();
        for (let i = 0; i < Math.min(64, 1 << (4 + (size << 1))); ++i) r.se();
      }
    }
  }
  r.bit(); // amp_enabled_flag
  r.bit(); // sample_adaptive_offset_enabled_flag
  if (r.bit()) {
    // pcm
    r.bits(8);
    r.ue();
    r.ue();
    r.bit();
  }
  // st_ref_pic_set: a set predicted from the one before it has an entry for
  // each of that one's pictures and itself, and as many pictures as it uses
  const sets = r.ue();
  const pictures: number[] = [];
  for (let k = 0; k < sets; ++k) {
    if (k > 0 && r.bit()) {
      r.bit(); // delta_rps_sign
      r.ue();
      let used = 0;
      for (let j = 0; j <= pictures[k - 1]; ++j) {
        if (r.bit() || r.bit()) ++used; // used_by_curr_pic_flag, use_delta_flag
      }
      pictures.push(used);
    } else {
      const n = r.ue() + r.ue();
      for (let j = 0; j < n; ++j) {
        r.ue();
        r.bit();
      }
      pictures.push(n);
    }
  }
  if (r.bit()) {
    // long-term reference pictures
    const n = r.ue();
    for (let i = 0; i < n; ++i) r.bits(pocBits + 1);
  }
  r.bit(); // sps_temporal_mvp_enabled_flag
  r.bit(); // strong_intra_smoothing_enabled_flag
  if (!r.bit()) return LIMITED; // vui_parameters_present_flag
  return vuiColor(r);
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

/** A plane's samples: `uint8` of 8 bits, `uint16` of 10. */
export type SampleArray = Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;

/** A chunk's planes: each `frames` pictures of its height and width,
 * row-major, of `depth` bits a sample (8 or 10). */
export interface ChunkPlanes {
  frames: number;
  depth: number;
  shapes: Record<Plane, [number, number]>;
  data: Partial<Record<Plane, SampleArray>>;
}

export function newChunkPlanes(
  frames: number,
  width: number,
  height: number,
  depth = 8,
): ChunkPlanes {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const array = (n: number) =>
    depth > 8 ? new Uint16Array(n) : new Uint8Array(n);
  return {
    frames,
    depth,
    shapes: { y: [height, width], u: [ch, cw], v: [ch, cw] },
    data: {
      y: array(frames * width * height),
      u: array(frames * cw * ch),
      v: array(frames * cw * ch),
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

/** The 4:2:0 formats of 8 bits a sample and of 10 (each in the low bits of a
 * little-endian 16-bit integer). */
const EIGHT_BIT = ["I420", "I420A", "NV12"];
const TEN_BIT = ["I420P10", "I420AP10"];

/** Whether a picture in `format` holds RGB converted from its decoder's Y, U
 * and V, as Firefox's VideoDecoder gives them. */
export function isRgbFormat(format: string) {
  return format in RGB_FORMATS;
}

/** Whether a picture in `format` holds its decoder's Y, U and V exactly, of
 * `depth` bits, rather than converted from them. */
export function isExactFormat(format: string, depth = 8) {
  return (depth > 8 ? TEN_BIT : EIGHT_BIT).includes(format);
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
 * pixel format `format`, into the chunk's planes at `position`: 4:2:0 of the
 * chunk's depth ("I420", "I420A" or "NV12" of 8 bits, "I420P10" or "I420AP10"
 * of 10) as it is, and, into 8-bit planes, RGB ("BGRX", "BGRA", "RGBX",
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
  if (out.depth > 8) {
    if (!TEN_BIT.includes(format)) {
      throw new Error(
        `refkv.stream: a picture decodes to ${format}, not 4:2:0 of ${out.depth} bits`,
      );
    }
    // little-endian 16-bit samples
    const copyWideRows = (
      from: PlaneLayoutLike,
      to: SampleArray,
      [h, w]: [number, number],
    ) => {
      const base = position * h * w;
      for (let r = 0; r < h; ++r) {
        const s = from.offset + r * from.stride;
        for (let c = 0; c < w; ++c) {
          to[base + r * w + c] = src[s + 2 * c] | (src[s + 2 * c + 1] << 8);
        }
      }
    };
    copyWideRows(layout[0], out.data.y!, out.shapes.y);
    copyWideRows(layout[1], out.data.u!, out.shapes.u);
    copyWideRows(layout[2], out.data.v!, out.shapes.v);
    return;
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
      `refkv.stream: a picture decodes to ${format}, not 8-bit 4:2:0 or RGB`,
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
  ): Promise<SampleArray> {
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
