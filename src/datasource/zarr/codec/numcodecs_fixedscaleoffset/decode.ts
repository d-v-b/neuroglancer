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
import type { Configuration } from "#src/datasource/zarr/codec/numcodecs_fixedscaleoffset/resolve.js";
import type { DataType } from "#src/util/data_type.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR } from "#src/util/data_type.js";

/**
 * Reverses numcodecs' `FixedScaleOffset`. An integer type truncates, and a
 * float32 rounds to nearest, as NumPy's cast of the float64 result does.
 */
export function unscale(
  encoded: ArrayBufferView<ArrayBuffer>,
  dataType: DataType,
  { scale, offset }: Configuration,
): ArrayBufferView<ArrayBuffer> {
  const stored = encoded as unknown as ArrayLike<number>;
  const decoded = new (DATA_TYPE_ARRAY_CONSTRUCTOR[dataType] as any)(
    stored.length,
  ) as { [i: number]: number } & ArrayBufferView<ArrayBuffer>;
  for (let i = 0, n = stored.length; i < n; ++i) {
    decoded[i] = stored[i] / scale + offset;
  }
  return decoded;
}

registerCodec({
  name: "numcodecs.fixedscaleoffset",
  kind: CodecKind.arrayToArray,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return unscale(encoded, decodedArrayInfo.dataType, configuration);
  },
});
