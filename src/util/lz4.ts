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
 * @file The LZ4 block format (https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md).
 */

/**
 * Decodes an LZ4 block of `decodedSize` bytes. Rejects a block that does not
 * fill exactly that size, or whose match reaches before the start of the
 * output, rather than return partial data.
 */
export function decodeLz4Block(
  encoded: Uint8Array,
  decodedSize: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(decodedSize);
  const end = encoded.length;
  let i = 0;
  let o = 0;
  const length = (initial: number): number => {
    let n = initial;
    if (n === 15) {
      let b: number;
      do {
        if (i >= end) throw new Error("lz4: the block ends inside a length");
        b = encoded[i++];
        n += b;
      } while (b === 255);
    }
    return n;
  };
  while (i < end) {
    const token = encoded[i++];
    const literals = length(token >> 4);
    if (i + literals > end || o + literals > decodedSize) {
      throw new Error("lz4: literals past the end of the block or the output");
    }
    out.set(encoded.subarray(i, i + literals), o);
    i += literals;
    o += literals;
    // the last sequence is literals alone
    if (i === end) break;
    if (i + 2 > end) throw new Error("lz4: the block ends inside an offset");
    const offset = encoded[i] | (encoded[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) {
      throw new Error(`lz4: an offset of ${offset} at output byte ${o}`);
    }
    const count = length(token & 15) + 4;
    if (o + count > decodedSize) {
      throw new Error("lz4: a match past the end of the output");
    }
    // byte by byte: a match may overlap the bytes it writes
    for (let k = 0; k < count; ++k, ++o) out[o] = out[o - offset];
  }
  if (o !== decodedSize) {
    throw new Error(`lz4: ${o} bytes decoded, not ${decodedSize}`);
  }
  return out;
}
