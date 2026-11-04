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
 * @file The `imagecodecs_webp` array-to-bytes codec, configuration
 * `{"hasalpha": a}`: each chunk is one WebP image, lossy or lossless, of a `uint8`
 * array whose shape ends in `[h, w, 3]` or `[h, w, 4]`, all other dimensions 1.
 * As in imagecodecs' `webp_decode`, `a` selects the samples, so it must agree
 * with the shape, and a chunk of 4 samples has alpha 255 if the image has none.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject, verifyOptionalObjectProperty } from "#src/util/json.js";

export type Configuration = Record<string, never>;

registerCodec({
  name: "imagecodecs_webp",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.UINT8) {
      throw new Error(
        `imagecodecs_webp supports the uint8 data type, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const rank = chunkShape.length;
    const samples = chunkShape[rank - 1];
    if (
      rank < 3 ||
      (samples !== 3 && samples !== 4) ||
      chunkShape.slice(0, rank - 3).some((n) => n !== 1)
    ) {
      throw new Error(
        `imagecodecs_webp: a chunk of shape [${chunkShape.join(", ")}] is not ` +
          "one image of 3 or 4 samples",
      );
    }
    if (configuration !== undefined) {
      verifyObject(configuration);
      verifyOptionalObjectProperty(configuration, "hasalpha", (value) => {
        if (typeof value !== "boolean") {
          throw new Error(
            `Expected boolean but received: ${JSON.stringify(value)}`,
          );
        }
        if (value !== (samples === 4)) {
          throw new Error(
            `hasalpha ${value} does not agree with ${samples} samples`,
          );
        }
      });
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
