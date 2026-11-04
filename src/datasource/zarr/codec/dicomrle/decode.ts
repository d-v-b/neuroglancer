/**
 * @license
 * Copyright 2023 Google Inc.
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

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/dicomrle/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import { convertEndian, Endianness } from "#src/util/endian.js";

const HEADER = 64;
const MAX_SEGMENTS = 15;

/**
 * Decodes one PackBits segment of `encoded[start, end)` into every `stride`-th
 * byte of `out` from `at`, `count` bytes.
 */
function decodeSegment(
  encoded: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  at: number,
  stride: number,
  count: number,
) {
  let p = start;
  const stop = at + count * stride;
  while (at < stop && p < end) {
    const n = encoded[p++];
    if (n < 128) {
      for (let k = n; k >= 0 && at < stop; --k, at += stride) {
        out[at] = encoded[p++];
      }
    } else if (n > 128) {
      const value = encoded[p++];
      for (let k = 257 - n; k > 0 && at < stop; --k, at += stride) {
        out[at] = value;
      }
    }
  }
  if (at < stop) {
    throw new Error(
      `imagecodecs_dicomrle: a segment ends ${(stop - at) / stride} bytes short`,
    );
  }
}

/**
 * The little-endian bytes of a frame of `numElements` elements of `size` bytes
 * each, its samples planar.
 */
export function decodeDicomRle(
  encoded: Uint8Array,
  numElements: number,
  size: number,
): Uint8Array<ArrayBuffer> {
  if (encoded.length < HEADER) {
    throw new Error(
      `imagecodecs_dicomrle: a frame of ${encoded.length} bytes has no header`,
    );
  }
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  const numSegments = view.getUint32(0, true);
  const samples = numSegments / size;
  if (
    numSegments < 1 ||
    numSegments > MAX_SEGMENTS ||
    !Number.isInteger(samples) ||
    numElements % samples !== 0
  ) {
    throw new Error(
      `imagecodecs_dicomrle: ${numSegments} segments for ${numElements} elements ` +
        `of ${size} bytes`,
    );
  }
  const perSample = numElements / samples;
  const out = new Uint8Array(numElements * size);
  for (let s = 0; s < numSegments; ++s) {
    const start = view.getUint32(4 + 4 * s, true);
    const end =
      s + 1 < numSegments ? view.getUint32(8 + 4 * s, true) : encoded.length;
    if (start < HEADER || end < start || end > encoded.length) {
      throw new Error(
        `imagecodecs_dicomrle: segment ${s} at [${start}, ${end}) of ${encoded.length} bytes`,
      );
    }
    // Most significant byte first, within each sample.
    const sample = Math.floor(s / size);
    const byte = size - 1 - (s % size);
    const at = sample * perSample * size + byte;
    decodeSegment(encoded, start, end, out, at, size, perSample);
  }
  return out;
}

registerCodec({
  name: "imagecodecs_dicomrle",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    configuration;
    signal.throwIfAborted();
    const { dataType, chunkShape } = decodedArrayInfo;
    const size = DATA_TYPE_BYTES[dataType];
    const numElements = chunkShape.reduce((a, b) => a * b, 1);
    const bytes = decodeDicomRle(encoded, numElements, size);
    const array = makeDataTypeArrayView(
      dataType,
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    convertEndian(array, Endianness.LITTLE, size);
    return array;
  },
});
