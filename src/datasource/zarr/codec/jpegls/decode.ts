/**
 * @license
 * Copyright 2023 Google Inc.
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
import { checkJpeg2kChunkShape } from "#src/datasource/zarr/codec/jpeg2k/decode.js";
import type { Configuration } from "#src/datasource/zarr/codec/jpegls/resolve.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import { decodeJpegLs } from "#src/util/jpegls.js";

registerCodec({
  name: "imagecodecs_jpegls",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    configuration;
    signal.throwIfAborted();
    const { dataType, chunkShape } = decodedArrayInfo;
    const { width, height, numComponents, data } = decodeJpegLs(encoded);
    checkJpeg2kChunkShape(chunkShape, width, height, numComponents, "JPEG-LS");
    // A stream of at most 8 bits decodes to bytes, in cells that may be wider.
    const cells =
      DATA_TYPE_BYTES[dataType] === 2 && data.BYTES_PER_ELEMENT === 1
        ? Uint16Array.from(data)
        : data;
    return makeDataTypeArrayView(
      dataType,
      cells.buffer,
      cells.byteOffset,
      cells.byteLength,
    );
  },
});
