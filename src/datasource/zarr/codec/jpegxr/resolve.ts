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
 * @file The `imagecodecs_jpegxr` array-to-bytes codec: each chunk is one
 * JPEG XR file (ITU-T T.832 with its container), as CZI JpgXr subblocks are
 * and as imagecodecs' `jpegxr_encode` writes. It decodes as imagecodecs'
 * `jpegxr_decode` (jxrlib) does: a gray image of height `h` and width `w`
 * fills a chunk whose shape ends in `[h, w]`, and a color image of `c`
 * samples (R, G, B and A, whatever order the file stores) one whose shape
 * ends in `[h, w, c]`. All other chunk dimensions must be 1. The codec has
 * no configuration.
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

export const JPEGXR_DATA_TYPES = [
  DataType.UINT8,
  DataType.UINT16,
  DataType.FLOAT32,
];

registerCodec({
  name: "imagecodecs_jpegxr",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    if (!JPEGXR_DATA_TYPES.includes(decodedArrayInfo.dataType)) {
      throw new Error(
        `imagecodecs_jpegxr supports uint8, uint16 and float32, not ${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
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
