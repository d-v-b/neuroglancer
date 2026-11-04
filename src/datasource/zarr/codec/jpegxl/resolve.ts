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

/**
 * @file The `imagecodecs_jpegxl` array-to-bytes codec: each chunk is one
 * lossless JPEG XL image of one frame, of `uint8`, `uint16` or `float32`
 * samples, as imagecodecs' `jpegxl_decode` reads it. A single-component image
 * of height `h` and width `w` fills a chunk whose shape ends in `[h, w]`, and
 * one of 3 or 4 components a chunk whose shape ends in `[h, w, c]`; all other
 * chunk dimensions must be 1. Encoder settings in the configuration are ignored.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject } from "#src/util/json.js";

export type Configuration = Record<string, never>;

registerCodec({
  name: "imagecodecs_jpegxl",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    const { dataType } = decodedArrayInfo;
    if (
      dataType !== DataType.UINT8 &&
      dataType !== DataType.UINT16 &&
      dataType !== DataType.FLOAT32
    ) {
      throw new Error(
        `imagecodecs_jpegxl supports the uint8, uint16 and float32 data types, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    return { configuration: {} };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
