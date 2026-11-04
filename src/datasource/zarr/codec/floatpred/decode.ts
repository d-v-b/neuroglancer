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

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/floatpred/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { ENDIANNESS, Endianness } from "#src/util/endian.js";

/**
 * Undoes the floating-point predictor, returning the values of the chunk in
 * C order and native byte order, as bytes. A row is one line along `axis`,
 * with the axis after it if there is one, of `row` values. Each byte of a row
 * is stored less the byte `stride` bytes before it, modulo 256, and after
 * summing them back the row holds its values' most significant bytes, then
 * their next bytes, and so on: the byte of significance `p` of value `v` (`p`
 * 0 the most significant) is at `p * row + v`.
 */
export function undoFloatPredictor(
  encoded: Uint8Array,
  shape: readonly number[],
  axis: number,
  bytesPerValue: number,
): Uint8Array<ArrayBuffer> {
  const stride = axis + 1 < shape.length ? shape[axis + 1] : 1;
  const row = shape[axis] * stride;
  const rowBytes = row * bytesPerValue;
  const expected = shape.reduce((a, b) => a * b, bytesPerValue);
  if (encoded.length !== expected) {
    throw new Error(
      `imagecodecs_floatpred: chunk is ${encoded.length} bytes, but a chunk of ` +
        `shape [${shape.join(", ")}] is ${expected} bytes`,
    );
  }
  const decoded = new Uint8Array(expected);
  const summed = new Uint8Array(rowBytes);
  const littleEndian = ENDIANNESS === Endianness.LITTLE;
  for (let start = 0; start < expected; start += rowBytes) {
    summed.set(encoded.subarray(start, start + stride));
    for (let i = stride; i < rowBytes; ++i) {
      summed[i] = encoded[start + i] + summed[i - stride];
    }
    for (let p = 0; p < bytesPerValue; ++p) {
      const offset = littleEndian ? bytesPerValue - 1 - p : p;
      const source = p * row;
      for (let v = 0; v < row; ++v) {
        decoded[start + v * bytesPerValue + offset] = summed[source + v];
      }
    }
  }
  return decoded;
}

registerCodec({
  name: "imagecodecs_floatpred",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { axis, bytesPerValue } = configuration;
    const { buffer } = undoFloatPredictor(
      encoded,
      decodedArrayInfo.chunkShape,
      axis,
      bytesPerValue,
    );
    if (bytesPerValue === 4) return new Float32Array(buffer);
    // Assigning a float64 to a float32 rounds it to nearest.
    const float64 = new Float64Array(buffer);
    const float32 = new Float32Array(float64.length);
    float32.set(float64);
    return float32;
  },
});
