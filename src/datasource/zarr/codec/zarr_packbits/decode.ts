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
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/zarr_packbits/resolve.js";
import { PaddingEncoding } from "#src/datasource/zarr/codec/zarr_packbits/resolve.js";

/**
 * The first `count` elements of `numBits` bits each of `encoded`, least
 * significant bit first, each shifted to `firstBit`.
 */
export function unpackBits(
  encoded: Uint8Array,
  count: number,
  numBits: number,
  firstBit: number,
): Uint8Array<ArrayBuffer> {
  const needed = Math.ceil((count * numBits) / 8);
  if (encoded.length < needed) {
    throw new Error(
      `packbits: a chunk of ${encoded.length} bytes, fewer than the ${needed} of ` +
        `${count} elements of ${numBits} bits`,
    );
  }
  const mask = (1 << numBits) - 1;
  const out = new Uint8Array(count);
  let bit = 0;
  for (let i = 0; i < count; ++i, bit += numBits) {
    const byte = bit >>> 3;
    const word = encoded[byte] | (encoded[byte + 1] << 8);
    out[i] = ((word >>> (bit & 7)) & mask) << firstBit;
  }
  return out;
}

registerCodec({
  name: "packbits",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { paddingEncoding, numBits, firstBit } = configuration;
    let data: Uint8Array = encoded;
    if (paddingEncoding === PaddingEncoding.FIRST_BYTE) {
      data = data.subarray(1);
    } else if (paddingEncoding === PaddingEncoding.LAST_BYTE) {
      data = data.subarray(0, data.length - 1);
    }
    const count = decodedArrayInfo.chunkShape.reduce((a, b) => a * b, 1);
    return unpackBits(data, count, numBits, firstBit);
  },
});
