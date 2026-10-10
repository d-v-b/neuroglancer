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

import { decodeJpegXr } from "#src/async_computation/decode_jpegxr_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { checkJpeg2kChunkShape } from "#src/datasource/zarr/codec/jpeg2k/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpegxr/resolve.js";
import type { DecodedJpegXr } from "#src/sliceview/jpegxr/index.js";
import {
  DATA_TYPE_BYTES,
  DataType,
  makeDataTypeArrayView,
} from "#src/util/data_type.js";
import { convertEndian, Endianness } from "#src/util/endian.js";

/**
 * Checks that a decoded JPEG XR image has the samples of `dataType` and fills
 * a chunk of shape `chunkShape` (see `resolve.ts`), and throws if not.
 */
export function checkJpegXrChunk(
  dataType: DataType,
  chunkShape: readonly number[],
  decoded: Omit<DecodedJpegXr, "data">,
) {
  const { width, height, numComponents, bytesPerSample, isFloat } = decoded;
  if (
    bytesPerSample !== DATA_TYPE_BYTES[dataType] ||
    isFloat !== (dataType === DataType.FLOAT32)
  ) {
    throw new Error(
      `JPEG XR image of ${bytesPerSample * 8}-bit ${isFloat ? "float" : "integer"} ` +
        `samples does not match data type ${DataType[dataType].toLowerCase()}`,
    );
  }
  checkJpeg2kChunkShape(chunkShape, width, height, numComponents, "JPEG XR");
}

registerCodec({
  name: "imagecodecs_jpegxr",
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
      decodeJpegXr,
      signal,
      [encoded.buffer],
      encoded,
    );
    checkJpegXrChunk(dataType, chunkShape, decoded);
    const { data } = decoded;
    const array = makeDataTypeArrayView(
      dataType,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    convertEndian(array, Endianness.LITTLE, decoded.bytesPerSample);
    return array;
  },
});
