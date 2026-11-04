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
import type { Configuration } from "#src/datasource/zarr/codec/delta/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { TypedArray } from "#src/util/array.js";

/**
 * Sums `data`, the C-order values of an array of shape `shape`, along `axis`,
 * in place: each value becomes itself plus the one before it on its line.
 * Assigning to the typed array wraps the sum to the data type's range.
 */
export function sumDifferences(
  data: TypedArray,
  shape: readonly number[],
  axis: number,
) {
  let stride = 1;
  for (let i = shape.length - 1; i > axis; --i) stride *= shape[i];
  const block = stride * shape[axis];
  // BigUint64Array holds bigints, so that this one line is not typed.
  const values = data as any;
  for (let start = 0; start < values.length; start += block) {
    const end = start + block;
    for (let i = start + stride; i < end; ++i) {
      values[i] += values[i - stride];
    }
  }
}

registerCodec({
  name: "imagecodecs_delta",
  kind: CodecKind.arrayToArray,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    sumDifferences(
      encoded as TypedArray,
      decodedArrayInfo.chunkShape,
      configuration.axis,
    );
    return encoded;
  },
});
