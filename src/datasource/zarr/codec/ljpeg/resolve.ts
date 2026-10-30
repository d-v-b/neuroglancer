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
 * @file The `imagecodecs_ljpeg` array-to-bytes codec: each chunk is one
 * lossless JPEG stream (ITU-T T.81 process 14, the SOF3 marker), as written
 * by imagecodecs' `ljpeg_encode` and as Olympus cellSens (VSI/ETS) slides
 * store tiles of compression 5. A single-component image of height `h` and
 * width `w` fills a chunk whose shape ends in `[h, w]`; a `c`-component
 * image fills a chunk whose shape ends in `[h, w, c]`. All other chunk
 * dimensions must be 1. Samples of 2 to 8 bits are `uint8`, of 9 to 16 bits
 * `uint16`. Encoder settings in the configuration (`bitspersample`) are
 * ignored.
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
  name: "imagecodecs_ljpeg",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    const { dataType } = decodedArrayInfo;
    if (dataType !== DataType.UINT8 && dataType !== DataType.UINT16) {
      throw new Error(
        `imagecodecs_ljpeg supports the uint8 and uint16 data types, not ${DataType[dataType].toLowerCase()}`,
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
