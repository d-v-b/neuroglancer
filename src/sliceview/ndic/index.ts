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
