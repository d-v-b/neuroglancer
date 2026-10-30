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

import { decodeLosslessJpeg } from "#src/async_computation/decode_ljpeg_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { checkJpeg2kChunkShape } from "#src/datasource/zarr/codec/jpeg2k/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/ljpeg/resolve.js";
import { DATA_TYPE_BYTES, DataType } from "#src/util/data_type.js";
import type { DecodedLosslessJpeg } from "#src/util/ljpeg.js";

// Checks that a decoded image fills a chunk: its shape (as for
// imagecodecs_jpeg2k), and 8-bit samples for uint8, 16-bit for uint16.
export function checkLosslessJpegChunk(
  dataType: DataType,
  chunkShape: readonly number[],
  decoded: Omit<DecodedLosslessJpeg, "data">,
) {
  const { width, height, numComponents, bitsPerSample } = decoded;
  if ((bitsPerSample <= 8 ? 1 : 2) !== DATA_TYPE_BYTES[dataType]) {
    throw new Error(
      `Lossless JPEG image of ${bitsPerSample}-bit samples does not match ` +
        `data type ${DataType[dataType].toLowerCase()}`,
    );
  }
  checkJpeg2kChunkShape(
    chunkShape,
    width,
    height,
    numComponents,
    "Lossless JPEG",
  );
}

registerCodec({
  name: "imagecodecs_ljpeg",
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
      decodeLosslessJpeg,
      signal,
      [encoded.buffer],
      encoded,
    );
    checkLosslessJpegChunk(dataType, chunkShape, decoded);
    // The decoder returns samples interleaved ([h, w, c]), as the chunk holds
    // them.
    return decoded.data;
  },
});
