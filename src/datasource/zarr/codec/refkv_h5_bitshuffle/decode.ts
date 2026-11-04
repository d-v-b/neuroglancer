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
import {
  decodeLz4Block,
  readFraming,
} from "#src/datasource/zarr/codec/lz4h5/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_h5_bitshuffle/resolve.js";

const WHAT = "refkv.h5_bitshuffle";
// A block's elements are a multiple of this (`BSHUF_BLOCKED_MULT`).
const MULTIPLE = 8;

/**
 * One block's elements from its rows: bit `i` of byte `j` of element `k` is
 * bit `k % 8` of byte `floor(k / 8)` of row `8j + i`.
 */
function untranspose(
  rows: Uint8Array,
  out: Uint8Array,
  elementSize: number,
): void {
  const rowBytes = rows.length / (8 * elementSize);
  for (let j = 0; j < elementSize; ++j) {
    const first = 8 * j * rowBytes;
    for (let g = 0; g < rowBytes; ++g) {
      for (let m = 0; m < 8; ++m) {
        let byte = 0;
        for (let i = 0; i < 8; ++i) {
          byte |= ((rows[first + i * rowBytes + g] >> m) & 1) << i;
        }
        out[(8 * g + m) * elementSize + j] = byte;
      }
    }
  }
}

function decodeBare(
  encoded: Uint8Array,
  elementSize: number,
  blockSize: number,
): Uint8Array<ArrayBuffer> {
  if (blockSize % MULTIPLE !== 0) {
    throw new Error(
      `${WHAT}: a block of ${blockSize} elements is not a multiple of ${MULTIPLE}`,
    );
  }
  if (encoded.length % elementSize !== 0) {
    throw new Error(
      `${WHAT}: ${encoded.length} bytes are not whole elements of ${elementSize} bytes`,
    );
  }
  const out = new Uint8Array(encoded.length);
  const blockBytes = blockSize * elementSize;
  const shuffled = encoded.length - (encoded.length % (MULTIPLE * elementSize));
  for (let at = 0; at < shuffled; at += blockBytes) {
    const end = Math.min(at + blockBytes, shuffled);
    untranspose(encoded.subarray(at, end), out.subarray(at, end), elementSize);
  }
  out.set(encoded.subarray(shuffled), shuffled);
  return out;
}

function decodeLz4(
  encoded: Uint8Array,
  elementSize: number,
): Uint8Array<ArrayBuffer> {
  const { total, block } = readFraming(encoded, WHAT);
  const out = new Uint8Array(total);
  if (total === 0) return out;
  if (block === 0 || block % (MULTIPLE * elementSize) !== 0) {
    throw new Error(
      `${WHAT}: a block of ${block} bytes is not a multiple of ${MULTIPLE * elementSize} bytes`,
    );
  }
  if (total % elementSize !== 0) {
    throw new Error(
      `${WHAT}: ${total} bytes are not whole elements of ${elementSize} bytes`,
    );
  }
  const view = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  const shuffled = total - (total % (MULTIPLE * elementSize));
  const plain = new Uint8Array(block);
  let s = 12;
  for (let d = 0; d < shuffled; ) {
    const n = Math.min(block, shuffled - d);
    if (s + 4 > encoded.length) {
      throw new Error(`${WHAT}: a chunk ends inside its framing`);
    }
    const stored = view.getUint32(s);
    s += 4;
    if (s + stored > encoded.length) {
      throw new Error(`${WHAT}: a chunk ends inside its framing`);
    }
    const rows = plain.subarray(0, n);
    decodeLz4Block(encoded.subarray(s, s + stored), rows, WHAT);
    untranspose(rows, out.subarray(d, d + n), elementSize);
    s += stored;
    d += n;
  }
  if (encoded.length - s !== total - shuffled) {
    throw new Error(
      `${WHAT}: ${encoded.length - s} bytes after the blocks, not the ${total - shuffled} left over`,
    );
  }
  out.set(encoded.subarray(s), shuffled);
  return out;
}

/** Decodes a chunk of HDF5's bitshuffle filter. */
export function decodeBitshuffle(
  encoded: Uint8Array,
  configuration: Configuration,
): Uint8Array<ArrayBuffer> {
  const { elementSize, blockSize, lz4 } = configuration;
  return lz4
    ? decodeLz4(encoded, elementSize)
    : decodeBare(encoded, elementSize, blockSize);
}

registerCodec({
  name: WHAT,
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    signal;
    return decodeBitshuffle(encoded, configuration);
  },
});
