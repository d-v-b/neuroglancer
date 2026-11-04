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
 * @file The `imagecodecs_floatpred` array-to-bytes codec, configuration
 * `{"axis": a, "dist": 1}` (`axis` -1 and `dist` 1 when absent): TIFF's
 * floating-point predictor, Predictor 3 of
 * [TIFF Technical Note 3](http://chriscox.org/TIFFTN3d1.pdf), as imagecodecs'
 * `floatpred_decode` undoes it. `a` must be the last axis or the one before
 * it: an axis after `a` holds the samples of a pixel. The stored bytes do not
 * depend on the file's byte order, so there is no `endian`. A float64 array
 * is shown as float32, its values rounded to nearest.
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
  // The axis of rows of the chunk's shape, in `[rank - 2, rank)`.
  axis: number;
  // The bytes of a stored value: 8 for a float64 array, otherwise 4.
  bytesPerValue: 4 | 8;
}

registerCodec({
  name: "imagecodecs_floatpred",
  kind: CodecKind.arrayToBytes,
  decodesFloat64AsFloat32: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
    float64: boolean,
  ): { configuration: Configuration; encodedSize: number } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.FLOAT32) {
      throw new Error(
        `imagecodecs_floatpred supports the float32 and float64 data types, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const rank = chunkShape.length;
    let axis = -1;
    if (configuration !== undefined) {
      verifyObject(configuration);
      axis = verifyOptionalObjectProperty(
        configuration,
        "axis",
        (value) => {
          if (
            !Number.isInteger(value) ||
            (value as number) < -rank ||
            (value as number) >= rank
          ) {
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
    if (axis < 0) axis += rank;
    if (rank - axis > 2) {
      throw new Error(
        `imagecodecs_floatpred: axis ${axis} is not one of the last two of a chunk of rank ${rank}`,
      );
    }
    const bytesPerValue = float64 ? 8 : 4;
    return {
      configuration: { axis, bytesPerValue },
      encodedSize: chunkShape.reduce((a, b) => a * b, bytesPerValue),
    };
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
