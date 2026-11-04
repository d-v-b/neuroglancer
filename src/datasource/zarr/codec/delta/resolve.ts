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
 * @file The `imagecodecs_delta` array-to-array codec, configuration
 * `{"axis": a, "dist": 1}` (`axis` -1 and `dist` 1 when absent): decoding sums
 * the differences along axis `a` of the encoded array, each line apart, modulo
 * the data type's range, as imagecodecs' `delta_decode` does. TIFF's horizontal
 * predictor (Predictor 2) stores exactly this along `x`. Like imagecodecs, this
 * has no `dist` but 1. The floating-point types are refused: imagecodecs sums
 * their bits as integers, which no writer of this codec is known to rely on.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject, verifyOptionalObjectProperty } from "#src/util/json.js";

export interface Configuration {
  // The axis of the encoded array to sum along, in `[0, rank)`.
  axis: number;
}

registerCodec({
  name: "imagecodecs_delta",
  kind: CodecKind.arrayToArray,
  changesValues: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType === DataType.FLOAT32) {
      throw new Error("imagecodecs_delta: float32 arrays are not supported");
    }
    const rank = chunkShape.length;
    let axis = -1;
    if (configuration !== undefined) {
      verifyObject(configuration);
      axis = verifyOptionalObjectProperty(
        configuration,
        "axis",
        (value) => {
          if (!Number.isInteger(value) || value < -rank || value >= rank) {
            throw new Error(
              `Expected integer in range [${-rank}, ${rank}) but received: ${JSON.stringify(value)}`,
            );
          }
          return value as number;
        },
        axis,
      );
      verifyOptionalObjectProperty(configuration, "dist", (value) => {
        if (value !== 1) {
          throw new Error(
            `Only a dist of 1 is supported, but received: ${JSON.stringify(value)}`,
          );
        }
      });
    }
    return {
      configuration: { axis: axis < 0 ? axis + rank : axis },
      encodedArrayInfo: decodedArrayInfo,
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    decodedArrayInfo;
    // Decoding a transpose only records a layout, so that this codec, were it
    // to follow one, would receive values that are not in its array's order.
    if (encodedLayout.physicalToLogicalDimension.some((d, i) => d !== i)) {
      throw new Error(
        "imagecodecs_delta is not supported before a transpose codec",
      );
    }
    return encodedLayout;
  },
});
