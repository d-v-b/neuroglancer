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
 * @file The `imagecodecs_htj2k` array-to-bytes codec (imagecodecs-zarr): each chunk is one HTJ2K codestream
 * (JPEG 2000 Part 15, as written by OpenJPH) holding one 2-D image of the chunk's last two dimensions.
 * Decoding uses the WebAssembly build of nd-image-codecs, which reads reversible 5/3, single-component,
 * single-tile codestreams.
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
  name: "imagecodecs_htj2k",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    // Encoder settings in the configuration are ignored.
    if (configuration !== undefined) verifyObject(configuration);
    const { dataType, chunkShape } = decodedArrayInfo;
    if (
      dataType !== DataType.UINT8 &&
      dataType !== DataType.INT8 &&
      dataType !== DataType.UINT16 &&
      dataType !== DataType.INT16
    ) {
      throw new Error(
        `imagecodecs_htj2k supports 8- and 16-bit integer data types, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const rank = chunkShape.length;
    if (rank < 2 || !chunkShape.slice(0, rank - 2).every((n) => n === 1)) {
      throw new Error(
        `imagecodecs_htj2k decodes one 2-D image per chunk, but the chunk shape is [${chunkShape}]`,
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
