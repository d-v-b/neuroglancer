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
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/numcodecs_shuffle/resolve.js";

/**
 * Reverses numcodecs' `Shuffle`: byte `j` of element `i` is at
 * `j * count + i` in `encoded`, `count` being the number of elements.
 * Like numcodecs, rejects a length that is not a multiple of `elementSize`.
 */
export function unshuffle(
  encoded: Uint8Array,
  elementSize: number,
): Uint8Array<ArrayBuffer> {
  const length = encoded.length;
  if (length % elementSize !== 0) {
    throw new Error(
      `numcodecs.shuffle: ${length} bytes are not a whole number of ${elementSize}-byte elements`,
    );
  }
  const count = length / elementSize;
  const decoded = new Uint8Array(length);
  if (elementSize === 2) {
    for (let i = 0; i < count; ++i) {
      decoded[2 * i] = encoded[i];
      decoded[2 * i + 1] = encoded[count + i];
    }
  } else {
    for (let j = 0; j < elementSize; ++j) {
      const offset = j * count;
      for (let i = 0; i < count; ++i) {
        decoded[i * elementSize + j] = encoded[offset + i];
      }
    }
  }
  return decoded;
}

registerCodec({
  name: "numcodecs.shuffle",
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    signal;
    const { elementSize } = configuration;
    if (elementSize === 1) return encoded;
    return unshuffle(encoded, elementSize);
  },
});
