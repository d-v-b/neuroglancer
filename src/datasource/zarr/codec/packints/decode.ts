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
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/packints/resolve.js";

/**
 * Unpacks `numSamples` samples of `bitsPerSample` bits, a whole number of runs
 * of `runLength` samples, each of which starts on a byte boundary.
 */
export function unpackInts(
  encoded: Uint8Array,
  numSamples: number,
  bitsPerSample: 1 | 12,
  runLength: number,
): Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> {
  const runBytes = Math.ceil((runLength * bitsPerSample) / 8);
  const numRuns = numSamples / runLength;
  const expected = runBytes * numRuns;
  if (encoded.length !== expected) {
    throw new Error(
      `imagecodecs_packints: chunk is ${encoded.length} bytes, but ${numRuns} ` +
        `runs of ${runBytes} bytes are ${expected} bytes`,
    );
  }
  if (bitsPerSample === 1) {
    const decoded = new Uint8Array(numSamples);
    for (let r = 0, o = 0; r < numRuns; ++r) {
      const start = r * runBytes;
      for (let i = 0; i < runLength; ++i, ++o) {
        decoded[o] = (encoded[start + (i >> 3)] >> (7 - (i & 7))) & 1;
      }
    }
    return decoded;
  }
  const decoded = new Uint16Array(numSamples);
  for (let r = 0, o = 0; r < numRuns; ++r) {
    let p = r * runBytes;
    for (let i = 0; i < runLength; ++i, ++o) {
      if (i & 1) {
        decoded[o] = ((encoded[p + 1] & 0x0f) << 8) | encoded[p + 2];
        p += 3;
      } else {
        decoded[o] = (encoded[p] << 4) | (encoded[p + 1] >> 4);
      }
    }
  }
  return decoded;
}

registerCodec({
  name: "imagecodecs_packints",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return unpackInts(
      encoded,
      decodedArrayInfo.chunkShape.reduce((a, b) => a * b, 1),
      configuration.bitsPerSample,
      configuration.runLength,
    );
  },
});
