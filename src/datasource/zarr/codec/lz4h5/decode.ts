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
import type { Configuration } from "#src/datasource/zarr/codec/lz4h5/resolve.js";

/**
 * Decodes an LZ4 block (lz4's `lz4_Block_format.md`) into `out`, which it must
 * fill exactly. `what` names the codec in a message.
 */
export function decodeLz4Block(
  src: Uint8Array,
  out: Uint8Array,
  what: string,
): void {
  const bad = () =>
    new Error(`${what}: an LZ4 block does not decode to its block`);
  let s = 0;
  let d = 0;
  const run = (first: number) => {
    let n = first;
    if (n === 15) {
      for (;;) {
        if (s >= src.length) throw bad();
        const b = src[s++];
        n += b;
        if (b !== 255) break;
      }
    }
    return n;
  };
  while (s < src.length) {
    const token = src[s++];
    const literals = run(token >> 4);
    if (s + literals > src.length || d + literals > out.length) throw bad();
    out.set(src.subarray(s, s + literals), d);
    s += literals;
    d += literals;
    // The last sequence is literals alone.
    if (s === src.length) break;
    if (s + 2 > src.length) throw bad();
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    const length = run(token & 15) + 4;
    if (offset === 0 || offset > d || d + length > out.length) throw bad();
    // A match may overlap what it writes, so a byte at a time.
    for (let k = 0; k < length; ++k, ++d) out[d] = out[d - offset];
  }
  if (d !== out.length) throw bad();
}

/**
 * Reads the 8-byte decoded length and 4-byte block size, both big-endian, that
 * start a chunk of HDF5's LZ4 and bitshuffle filters. The length is bounded
 * by what the chunk can hold, so that a corrupt one allocates nothing.
 */
export function readFraming(
  encoded: Uint8Array,
  what: string,
): { total: number; block: number } {
  if (encoded.length < 12) {
    throw new Error(`${what}: a chunk ends inside its framing`);
  }
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  const total = view.getBigUint64(0);
  const block = view.getUint32(8);
  // LZ4 expands at most 255 times.
  if (total > BigInt(encoded.length) * 255n + BigInt(block)) {
    throw new Error(
      `${what}: ${total} decoded bytes from a chunk of ${encoded.length} bytes`,
    );
  }
  return { total: Number(total), block };
}

/**
 * Decodes a chunk of HDF5's LZ4 filter: its framing, then blocks of the block
 * size (the last may be shorter), each its stored length (4 bytes, big-endian)
 * and an LZ4 block, or the bytes themselves when that length is the block's.
 */
export function decodeLz4h5(encoded: Uint8Array): Uint8Array<ArrayBuffer> {
  const what = "imagecodecs_lz4h5";
  const { total, block } = readFraming(encoded, what);
  const out = new Uint8Array(total);
  if (total === 0) return out;
  if (block === 0) throw new Error(`${what}: a block size of 0`);
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  let s = 12;
  for (let d = 0; d < total; ) {
    const n = Math.min(block, total - d);
    if (s + 4 > encoded.length) {
      throw new Error(`${what}: a chunk ends inside its framing`);
    }
    const stored = view.getUint32(s);
    s += 4;
    if (s + stored > encoded.length) {
      throw new Error(`${what}: a chunk ends inside its framing`);
    }
    const body = encoded.subarray(s, s + stored);
    if (stored === n) {
      out.set(body, d);
    } else {
      decodeLz4Block(body, out.subarray(d, d + n), what);
    }
    s += stored;
    d += n;
  }
  return out;
}

registerCodec({
  name: "imagecodecs_lz4h5",
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    configuration;
    signal;
    return decodeLz4h5(encoded);
  },
});
