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
 * @file Decoders for the nd-image-codecs Zarr v3 codecs `htj2k` and `nd_lift`, from the WebAssembly build of
 * https://github.com/fideus-labs/nd-image-codecs (see README.md in this directory).
 */

import init, {
  htj2k_decode,
  nd_lift_decode,
} from "#src/sliceview/ndic/ndic_zarr.js";

let initPromise: Promise<unknown> | undefined;

function ensureInitialized() {
  if (initPromise === undefined) {
    initPromise = init({
      module_or_path: fetch(new URL("./ndic_zarr_bg.wasm", import.meta.url)),
    });
  }
  return initPromise;
}

/**
 * Decodes an `htj2k` chunk (nd-image-codecs container: header, plane index, one HTJ2K codestream per
 * trailing 2-D plane) to little-endian samples of `dtype` in C order. The last two entries of `shape` are
 * `(y, x)`.
 */
export async function decodeHtj2kChunk(
  chunk: Uint8Array,
  shape: readonly number[],
  dtype: string,
): Promise<Uint8Array<ArrayBuffer>> {
  await ensureInitialized();
  // wasm-bindgen returns a fresh copy in JavaScript memory.
  return htj2k_decode(
    chunk,
    Uint32Array.from(shape),
    dtype,
  ) as Uint8Array<ArrayBuffer>;
}

/**
 * Inverts an `nd_lift` transform: `chunk` holds the widened (little-endian int32) coefficient array of
 * shape `shape`; the result holds samples of `dtype` in C order. `configuration` is the codec's Zarr v3
 * configuration object.
 */
export async function decodeNdLiftChunk(
  chunk: Uint8Array,
  shape: readonly number[],
  dtype: string,
  configuration: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  await ensureInitialized();
  return nd_lift_decode(
    chunk,
    Uint32Array.from(shape),
    dtype,
    JSON.stringify(configuration),
  ) as Uint8Array<ArrayBuffer>;
}

function readUint32(data: Uint8Array, offset: number) {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * Wraps one bare HTJ2K codestream (as `imagecodecs_htj2k` stores a chunk) in the smallest nd-image-codecs
 * `htj2k` container: the `ndht` header, with no plane index, followed by the codestream. `shape` is the
 * chunk shape, whose leading entries must be 1 and whose last two entries must match the codestream's
 * height and width.
 */
export function wrapHtj2kCodestream(
  codestream: Uint8Array,
  shape: readonly number[],
): Uint8Array<ArrayBuffer> {
  if (codestream[0] !== 0xff || codestream[1] !== 0x4f) {
    throw new Error("HTJ2K codestream does not start with an SOC marker");
  }
  let width: number | undefined;
  let height: number | undefined;
  let levels: number | undefined;
  for (let pos = 2; pos + 4 <= codestream.length; ) {
    const marker = (codestream[pos] << 8) | codestream[pos + 1];
    if (marker === 0xff90) break; // SOT: the main header is over
    if (marker === 0xff51) {
      // SIZ: Rsiz, Xsiz, Ysiz, XOsiz, YOsiz, ...
      width =
        readUint32(codestream, pos + 6) - readUint32(codestream, pos + 14);
      height =
        readUint32(codestream, pos + 10) - readUint32(codestream, pos + 18);
    } else if (marker === 0xff52) {
      // COD: Scod, progression, layers, MCT, then the decomposition levels.
      levels = codestream[pos + 9];
    }
    pos += 2 + ((codestream[pos + 2] << 8) | codestream[pos + 3]);
  }
  if (width === undefined || height === undefined || levels === undefined) {
    throw new Error("HTJ2K codestream has no SIZ or COD marker segment");
  }
  const rank = shape.length;
  if (
    rank < 2 ||
    shape[rank - 2] !== height ||
    shape[rank - 1] !== width ||
    !shape.slice(0, rank - 2).every((n) => n === 1)
  ) {
    throw new Error(
      `HTJ2K image of shape [${height}, ${width}] does not fill a chunk of shape [${shape}]`,
    );
  }
  const headerSize = 8 + 4 * rank;
  const container = new Uint8Array(headerSize + codestream.length);
  container.set([0x6e, 0x64, 0x68, 0x74, 1, 0, levels, rank]); // "ndht", version 1, no index
  const view = new DataView(container.buffer);
  shape.forEach((n, i) => view.setUint32(8 + 4 * i, n, true));
  container.set(codestream, headerSize);
  return container;
}

/**
 * Decodes one bare HTJ2K codestream (reversible 5/3, one component, one tile) to little-endian samples of
 * `dtype`, as stored by the `imagecodecs_htj2k` Zarr codec.
 */
export async function decodeHtj2kCodestream(
  codestream: Uint8Array,
  shape: readonly number[],
  dtype: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return decodeHtj2kChunk(wrapHtj2kCodestream(codestream, shape), shape, dtype);
}
