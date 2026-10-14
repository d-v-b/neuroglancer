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

import type { Configuration } from "#src/datasource/zarr/codec/cast_value/resolve.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { DataType } from "#src/util/data_type.js";

const TYPED_ARRAYS = {
  [DataType.UINT8]: Uint8Array,
  [DataType.INT8]: Int8Array,
  [DataType.UINT16]: Uint16Array,
  [DataType.INT16]: Int16Array,
  [DataType.UINT32]: Uint32Array,
  [DataType.INT32]: Int32Array,
  [DataType.FLOAT32]: Float32Array,
} as Record<
  number,
  { new (length: number): ArrayBufferView<ArrayBuffer> & ArrayLike<number> }
>;

/**
 * Decodes values encoded by the `cast_value` codec: converts them to the decoded data type, and
 * maps the values of `decodeMap`.
 */
export function decodeCastValue(
  configuration: Configuration,
  decodedDataType: DataType,
  encoded: ArrayLike<number>,
): ArrayBufferView<ArrayBuffer> {
  const ArrayType = TYPED_ARRAYS[decodedDataType];
  if (ArrayType === undefined) {
    throw new Error(`Unsupported data type: ${DataType[decodedDataType]}`);
  }
  const decoded = new ArrayType(encoded.length) as unknown as {
    [index: number]: number;
  };
  const { decodeMap } = configuration;
  const n = encoded.length;
  if (decodeMap.length === 0) {
    for (let i = 0; i < n; ++i) decoded[i] = encoded[i];
  } else {
    for (let i = 0; i < n; ++i) {
      const value = encoded[i];
      let result = value;
      for (const [from, to] of decodeMap) {
        if (value === from || (Number.isNaN(from) && Number.isNaN(value))) {
          result = to;
          break;
        }
      }
      decoded[i] = result;
    }
  }
  return decoded as unknown as ArrayBufferView<ArrayBuffer>;
}

registerCodec({
  name: "cast_value",
  kind: CodecKind.arrayToArray,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal;
    return decodeCastValue(
      configuration,
      decodedArrayInfo.dataType,
      encoded as unknown as ArrayLike<number>,
    );
  },
});
