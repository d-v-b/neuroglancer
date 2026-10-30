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
 * @file The `refkv.grib` array-to-bytes codec (refkv's spec/conventions.md,
 * section 12): a chunk is one GRIB edition 2 message, whose field (the
 * configuration's `field`, 0 when absent) is decoded into the grid's values,
 * NaN where missing, a chunk's last two dimensions the grid's rows and
 * columns. The array is float64 or float32; a float64 array is shown as
 * float32, its values rounded to nearest, as the codec decodes a float32
 * array's.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyInt,
  verifyObject,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  /** The configuration as the array's metadata gives it. */
  raw: unknown;
}

registerCodec({
  name: "refkv.grib",
  kind: CodecKind.arrayToBytes,
  decodesFloat64AsFloat32: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) {
      for (const key of Object.keys(verifyObject(configuration))) {
        if (key !== "field") {
          throw new Error(
            `refkv.grib: unknown configuration member ${JSON.stringify(key)}`,
          );
        }
      }
      verifyOptionalObjectProperty(configuration, "field", (value) => {
        const field = verifyInt(value);
        if (field < 0) {
          throw new Error(`refkv.grib: field ${field} is negative`);
        }
      });
    }
    if (decodedArrayInfo.dataType !== DataType.FLOAT32) {
      throw new Error(
        `refkv.grib: a GRIB field is not ${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
      );
    }
    return { configuration: { raw: configuration } };
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
