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
 * @file The `imagecodecs_ccittfax4` array-to-bytes codec, which has no
 * configuration: each chunk is one CCITT Group 4 stream (ITU-T T.6), bits
 * filled most significant bit first, of an image of `h` rows of `w` pixels,
 * the last two dimensions of the chunk, whose other dimensions are 1. It decodes
 * to a `uint8` array: a coded black run is 1, and a coded white run 0, with no
 * photometric interpretation applied.
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
  name: "imagecodecs_ccittfax4",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.UINT8) {
      throw new Error(
        `imagecodecs_ccittfax4 supports the uint8 data type, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const lead = chunkShape.length - 2;
    if (lead < 0 || chunkShape.slice(0, lead).some((n) => n !== 1)) {
      throw new Error(
        `imagecodecs_ccittfax4: a chunk of shape [${chunkShape.join(", ")}] ` +
          "is not one image: all but its last two dimensions must be 1",
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
