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

import { decodeNdicHtj2k } from "#src/async_computation/decode_ndic_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/htj2k/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { DataType, makeDataTypeArrayView } from "#src/util/data_type.js";

/** The data type name the nd-image-codecs WebAssembly decoders take. */
export function ndicDataTypeName(dataType: DataType) {
  return DataType[dataType].toLowerCase();
}

registerCodec({
  name: "htj2k",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    configuration;
    const { dataType, chunkShape } = decodedArrayInfo;
    const decoded = await requestAsyncComputation(
      decodeNdicHtj2k,
      signal,
      [encoded.buffer],
      encoded,
      Array.from(chunkShape),
      ndicDataTypeName(dataType),
    );
    const expectedBytes =
      chunkShape.reduce((a, b) => a * b, 1) * bytesPerSample(dataType);
    if (decoded.byteLength !== expectedBytes) {
      throw new Error(
        `htj2k chunk decoded to ${decoded.byteLength} bytes, expected ${expectedBytes} for shape [${chunkShape}]`,
      );
    }
    return makeDataTypeArrayView(
      dataType,
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
  },
});

function bytesPerSample(dataType: DataType) {
  switch (dataType) {
    case DataType.UINT8:
    case DataType.INT8:
      return 1;
    case DataType.UINT16:
    case DataType.INT16:
      return 2;
    default:
      return 4;
  }
}
