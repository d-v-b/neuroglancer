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

import { decodeLerc } from "#src/async_computation/decode_lerc_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/lerc/resolve.js";
import { DataType, makeDataTypeArrayView } from "#src/util/data_type.js";
import type { DecodedLerc } from "#src/util/lerc.js";

const PIXEL_TYPES: Record<DecodedLerc["pixelType"], DataType> = {
  S8: DataType.INT8,
  U8: DataType.UINT8,
  S16: DataType.INT16,
  U16: DataType.UINT16,
  S32: DataType.INT32,
  U32: DataType.UINT32,
  F32: DataType.FLOAT32,
  // A float64 array, whose data type is shown as float32.
  F64: DataType.FLOAT32,
};

// Checks that a decoded blob fills a chunk, and returns its values as an array
// of the chunk's data type. The shape is the one imagecodecs gives the blob.
export function lercChunkArray(
  dataType: DataType,
  chunkShape: readonly number[],
  decoded: DecodedLerc,
) {
  const { width, height, numBands, depth, pixelType, data } = decoded;
  if (PIXEL_TYPES[pixelType] !== dataType) {
    throw new Error(
      `LERC blob of ${pixelType} values does not match data type ${DataType[dataType].toLowerCase()}`,
    );
  }
  const blobShape = [
    ...(numBands > 1 ? [numBands] : []),
    height,
    width,
    ...(depth > 1 ? [depth] : []),
  ];
  const lead = chunkShape.length - blobShape.length;
  if (
    lead < 0 ||
    chunkShape.slice(0, lead).some((n) => n !== 1) ||
    blobShape.some((n, i) => chunkShape[lead + i] !== n)
  ) {
    throw new Error(
      `LERC blob of shape [${blobShape.join(", ")}] does not fill a chunk of ` +
        `shape [${chunkShape.join(", ")}]`,
    );
  }
  if (pixelType === "F64") {
    // Assigning a float64 to a float32 rounds it to nearest.
    const float64 = new Float64Array(data.buffer);
    const float32 = new Float32Array(float64.length);
    float32.set(float64);
    return float32;
  }
  return makeDataTypeArrayView(
    dataType,
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );
}

registerCodec({
  name: "imagecodecs_lerc",
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
      decodeLerc,
      signal,
      [encoded.buffer],
      encoded,
    );
    return lercChunkArray(dataType, chunkShape, decoded);
  },
});
