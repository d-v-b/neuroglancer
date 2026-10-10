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

import {
  decodeArray,
  registerCodec,
} from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/n5_default/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { copyBox } from "#src/datasource/zarr/metadata/chunk_grid.js";
import type { TypedArray } from "#src/util/array.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";

/**
 * Parses the header of an N5 block of a `rank`-dimensional array: returns
 * the block's size (in the array's dimension order) and the offset of its
 * body. Throws unless the block is in default mode (0) with `rank`
 * dimensions.
 */
export function parseN5BlockHeader(
  block: Uint8Array,
  rank: number,
): { shape: number[]; bodyOffset: number } {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  if (block.byteLength < 4) {
    throw new Error("n5_default: N5 block shorter than its header");
  }
  const mode = dv.getUint16(0, /*littleEndian=*/ false);
  if (mode !== 0) {
    throw new Error(`n5_default: N5 block mode ${mode} is not default (0)`);
  }
  const numDimensions = dv.getUint16(2, /*littleEndian=*/ false);
  if (numDimensions !== rank) {
    throw new Error(
      `n5_default: N5 block has ${numDimensions} dimensions, the array ${rank}`,
    );
  }
  const bodyOffset = 4 + 4 * rank;
  if (block.byteLength < bodyOffset) {
    throw new Error("n5_default: N5 block shorter than its header");
  }
  const shape = new Array<number>(rank);
  for (let i = 0; i < rank; ++i) {
    shape[i] = dv.getUint32(4 + 4 * i, /*littleEndian=*/ false);
  }
  return { shape, bodyOffset };
}

registerCodec({
  name: "n5_default",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    const { dataType, chunkShape } = decodedArrayInfo;
    const rank = chunkShape.length;
    const { shape, bodyOffset } = parseN5BlockHeader(encoded, rank);
    const same = shape.every((n, i) => n === chunkShape[i]);
    const inner = same
      ? configuration.inner
      : parseCodecChainSpec(configuration.codecs, {
          dataType,
          chunkShape: shape,
        });
    const decoded = await decodeArray(
      inner,
      encoded.subarray(bodyOffset),
      signal,
    );
    if (same) return decoded;
    // Truncate, or pad with zeros, to the chunk's shape. Both arrays are laid
    // out as the inner codecs leave them: physical dimension `i` (outermost
    // first) is logical dimension `physicalToLogicalDimension[i]`.
    const { physicalToLogicalDimension } = inner.layoutInfo[0];
    const fOrder = (s: readonly number[]) =>
      Array.from(
        { length: rank },
        (_, i) => s[physicalToLogicalDimension[rank - 1 - i]],
      );
    const destShape = fOrder(chunkShape);
    const srcShape = fOrder(shape);
    const zeros = new Array<number>(rank).fill(0);
    const dest = makeDataTypeArrayView(
      dataType,
      new ArrayBuffer(
        DATA_TYPE_BYTES[dataType] * chunkShape.reduce((a, b) => a * b, 1),
      ),
    ) as TypedArray<ArrayBuffer>;
    copyBox(
      dest,
      destShape,
      zeros,
      decoded as TypedArray<ArrayBuffer>,
      srcShape,
      zeros,
      destShape.map((n, i) => Math.min(n, srcShape[i])),
    );
    return dest;
  },
});
