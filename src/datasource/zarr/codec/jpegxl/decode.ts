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

import { decodeJxlSamples } from "#src/async_computation/decode_jxl_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { checkJpeg2kChunkShape } from "#src/datasource/zarr/codec/jpeg2k/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpegxl/resolve.js";
import type { DecodedJxlSamples } from "#src/sliceview/jxl/index.js";
import {
  DATA_TYPE_BYTES,
  DataType,
  makeDataTypeArrayView,
} from "#src/util/data_type.js";

// Checks that a decoded image fills a chunk (as for imagecodecs_jpeg2k), and
// returns its samples as an array of the chunk's data type.
export function jxlChunkArray(
  dataType: DataType,
  chunkShape: readonly number[],
  decoded: DecodedJxlSamples,
) {
  const { width, height, numComponents, data } = decoded;
  if (numComponents !== 1 && numComponents !== 3 && numComponents !== 4) {
    throw new Error(
      `JPEG XL image of ${numComponents} components is not supported`,
    );
  }
  checkJpeg2kChunkShape(chunkShape, width, height, numComponents, "JPEG XL");
  return makeDataTypeArrayView(
    dataType,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
}

registerCodec({
  name: "imagecodecs_jpegxl",
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
      decodeJxlSamples,
      signal,
      [encoded.buffer],
      encoded,
      DATA_TYPE_BYTES[dataType],
      dataType === DataType.FLOAT32,
    );
    return jxlChunkArray(dataType, chunkShape, decoded);
  },
});
