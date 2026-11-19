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
 * @file HEVC decoding with `libde265.wasm`, libde265 built with emscripten
 * (see `hevc_wasm.c` and `build.sh`), in software and so the same in every
 * browser: Main, Main 10 and the Range Extensions' 4:0:0, 4:2:0 and 4:2:2
 * pictures of 8 to 16 bits, each plane as the decoder gives it. HEVC decoding
 * is exact (H.265 8: every conforming decoder gives the same samples), and a
 * stream's SEI picture hashes, when it has them, are checked.
 *
 * libde265 is LGPL-3.0 (`LICENSE`): `libde265.wasm` is a module of its own,
 * built from the commit `Dockerfile` pins, which `build.sh` rebuilds.
 */

import type { Chroma, ChunkPlanes, Plane } from "#src/util/refkv_stream.js";
import { hvccNalUnits, newChunkPlanes } from "#src/util/refkv_stream.js";

// WASI error code ENOSYS: libde265 writes nothing, and uses no files.
const ENOSYS = 52;

const libraryEnv = {
  emscripten_notify_memory_growth: () => {},
  fd_write: () => ENOSYS,
  fd_close: () => ENOSYS,
  fd_seek: () => ENOSYS,
};

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(ptr: number): void;
  hevc_new(): number;
  hevc_free(ctx: number): void;
  hevc_push_nal(ctx: number, data: number, length: number, pts: number): number;
  hevc_flush(ctx: number): number;
  hevc_decode(ctx: number, more: number): number;
  hevc_warning(ctx: number): number;
  hevc_error_text(error: number): number;
  hevc_next_picture(ctx: number): number;
  hevc_picture_info(img: number, info: number): void;
  hevc_plane(img: number, channel: number, info: number): number;
}

// de265_error (libde265/de265.h)
const DE265_OK = 0;
const DE265_ERROR_IMAGE_BUFFER_FULL = 9;
const DE265_ERROR_WAITING_FOR_INPUT_DATA = 13;
// The warnings that say nothing of the pictures: no worker threads, and SEI
// messages it does not read. Every other one, such as a missing reference
// picture, means a picture may not be the stream's, and fails the chunk.
const HARMLESS_WARNINGS = new Set([
  1000, // DE265_WARNING_NO_WPP_CANNOT_USE_MULTITHREADING
  1022, // DE265_WARNING_NUMBER_OF_THREADS_LIMITED_TO_MAXIMUM
  1025, // DE265_WARNING_SPS_MISSING_CANNOT_DECODE_SEI
  1036, // DE265_WARNING_MAX_NUMBER_OF_SEI_MESSAGES_EXCEEDED
]);

const CHROMA: Record<number, Chroma> = { 0: "4:0:0", 1: "4:2:0", 2: "4:2:2" };

let modulePromise: Promise<WebAssembly.Instance> | undefined;

function getModule() {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./libde265.wasm", import.meta.url)),
          { env: libraryEnv, wasi_snapshot_preview1: libraryEnv },
        )
      ).instance;
      (m.exports as unknown as Exports)._initialize();
      return m;
    })();
    modulePromise.catch(() => {
      modulePromise = undefined;
    });
  }
  return modulePromise;
}

/** Instantiates `libde265.wasm` from its bytes, as `getModule` does from its
 * URL. */
export async function instantiateHevc(
  bytes: BufferSource,
): Promise<WebAssembly.Instance> {
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: libraryEnv,
    wasi_snapshot_preview1: libraryEnv,
  });
  (instance.exports as unknown as Exports)._initialize();
  return instance;
}

function cString(memory: WebAssembly.Memory, ptr: number) {
  const bytes = new Uint8Array(memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) ++end;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

/** The planes of a `refkv.stream` HEVC chunk: the frames `units` (access
 * units, each NAL unit after its length, of the size the hvcC payload `setup`
 * gives) decoded in order by a decoder in its initial state, the picture of
 * frame `k` copied to `positions[k]` of the chunk's `frames` (none when -1),
 * each plane of `depth` bits a sample and `chroma`, as the stream's are. */
export function decodeHevcWith(
  instance: WebAssembly.Instance,
  setup: Uint8Array,
  units: readonly Uint8Array[],
  positions: readonly number[],
  frames: number,
  depth: number,
  chroma: Chroma,
): ChunkPlanes {
  const x = instance.exports as unknown as Exports;
  const { lengthSize, nalUnits } = hvccNalUnits(setup);
  const total =
    nalUnits.reduce((n, u) => n + u.length, 0) +
    units.reduce((n, u) => n + u.length, 0);
  // `more`, a picture's 5 fields and a plane's 4, then the input
  const scratch = x.malloc(40 + total);
  if (scratch === 0) throw new Error("refkv.stream: out of memory for HEVC");
  const input = scratch + 40;
  const ctx = x.hevc_new();
  let planes: ChunkPlanes | undefined;
  try {
    if (ctx === 0) throw new Error("refkv.stream: out of memory for HEVC");
    const fail = (error: number) =>
      new Error(
        `refkv.stream: libde265 fails to decode the HEVC chunk: ${cString(x.memory, x.hevc_error_text(error))}`,
      );
    const check = (error: number) => {
      if (error !== DE265_OK) throw fail(error);
    };
    let at = input;
    const push = (nal: Uint8Array, pts: number) => {
      new Uint8Array(x.memory.buffer).set(nal, at);
      check(x.hevc_push_nal(ctx, at, nal.length, pts));
      at += nal.length;
    };
    for (const nal of nalUnits) push(nal, -1);
    units.forEach((unit, k) => {
      for (let i = 0; i < unit.length; ) {
        if (i + lengthSize > unit.length) {
          throw new Error(
            `refkv.stream: HEVC frame ${k} ends inside a NAL unit's length`,
          );
        }
        let length = 0;
        for (let j = 0; j < lengthSize; ++j)
          length = length * 256 + unit[i + j];
        i += lengthSize;
        if (i + length > unit.length) {
          throw new Error(
            `refkv.stream: HEVC frame ${k}'s NAL unit of ${length} bytes overruns its ${unit.length}`,
          );
        }
        push(unit.subarray(i, i + length), k);
        i += length;
      }
    });
    check(x.hevc_flush(ctx));

    const copyPicture = (img: number) => {
      x.hevc_picture_info(img, scratch + 4);
      const [k, chromaIdc, width, height, bits] = new Int32Array(
        x.memory.buffer,
        scratch + 4,
        5,
      );
      if (CHROMA[chromaIdc] !== chroma || bits !== depth) {
        throw new Error(
          `refkv.stream: an HEVC picture decodes to ${CHROMA[chromaIdc] ?? "4:4:4"} of ${bits} bits, not the stream's ${chroma} of ${depth}`,
        );
      }
      const position = positions[k];
      if (position === undefined || position < 0) return;
      planes ??= newChunkPlanes(frames, width, height, depth, chroma);
      if (position >= frames) {
        throw new Error(
          `refkv.stream: a picture at ${position} is outside the chunk's ${frames}`,
        );
      }
      for (const [channel, plane] of (["y", "u", "v"] as Plane[]).entries()) {
        const out = planes.data[plane];
        if (out === undefined) continue;
        const ptr = x.hevc_plane(img, channel, scratch + 24);
        const [w, h, stride, planeBits] = new Int32Array(
          x.memory.buffer,
          scratch + 24,
          4,
        );
        if (planeBits !== depth) {
          throw new Error(
            `refkv.stream: an HEVC picture's ${plane} plane is of ${planeBits} bits, not its luma's ${depth}`,
          );
        }
        const [ph, pw] = planes.shapes[plane];
        if (w !== pw || h !== ph) {
          throw new Error(
            `refkv.stream: an HEVC picture's ${plane} plane is ${w} x ${h}, not the chunk's ${pw} x ${ph}`,
          );
        }
        const base = position * h * w;
        const memory = x.memory.buffer;
        for (let r = 0; r < h; ++r) {
          const row = ptr + r * stride;
          if (depth > 8) {
            // little-endian uint16, as wasm's memory is
            const src =
              row % 2 === 0
                ? new Uint16Array(memory, row, w)
                : new Uint16Array(memory.slice(row, row + 2 * w));
            out.set(src, base + r * w);
          } else {
            out.set(new Uint8Array(memory, row, w), base + r * w);
          }
        }
      }
    };

    for (;;) {
      const error = x.hevc_decode(ctx, scratch);
      const more = new Int32Array(x.memory.buffer, scratch, 1)[0];
      let pictures = 0;
      for (let img; (img = x.hevc_next_picture(ctx)) !== 0; ++pictures) {
        copyPicture(img);
      }
      for (let w; (w = x.hevc_warning(ctx)) !== DE265_OK; ) {
        if (!HARMLESS_WARNINGS.has(w)) throw fail(w);
      }
      if (error === DE265_ERROR_IMAGE_BUFFER_FULL && pictures > 0) continue;
      if (error === DE265_ERROR_WAITING_FOR_INPUT_DATA) break;
      check(error);
      if (!more) break;
    }
  } finally {
    if (ctx !== 0) x.hevc_free(ctx);
    x.free(scratch);
  }
  return planes ?? newChunkPlanes(frames, 0, 0, depth, chroma);
}

/** `decodeHevcWith` this thread's instance of `libde265.wasm`: one that
 * traps (a failed assertion of libde265's) is discarded, for the next chunk to
 * start from a new one. */
export async function decodeHevc(
  setup: Uint8Array,
  units: readonly Uint8Array[],
  positions: readonly number[],
  frames: number,
  depth: number,
  chroma: Chroma,
): Promise<ChunkPlanes> {
  const instance = await getModule();
  try {
    return decodeHevcWith(
      instance,
      setup,
      units,
      positions,
      frames,
      depth,
      chroma,
    );
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) modulePromise = undefined;
    throw e;
  }
}
