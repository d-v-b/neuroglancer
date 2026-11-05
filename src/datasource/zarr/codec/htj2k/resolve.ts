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
 * @file The nd-image-codecs `htj2k` array-to-bytes codec
 * (https://github.com/fideus-labs/nd-image-codecs): each trailing 2-D `(y, x)` plane of a chunk is an
 * independent JPEG 2000 Part 1 / Part 15 (HTJ2K) codestream, preceded by a header and a coefficient-plane
 * index. It usually follows the `nd_lift` codec, which widens the samples to int32.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyBoolean,
  verifyInt,
  verifyObject,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

export interface Configuration {
  xy_levels?: number;
  reversible?: boolean;
  progression?: string;
  index?: boolean;
}

const PROGRESSIONS = ["LRCP", "RLCP", "RPCL", "PCRL", "CPRL"];

/** The sample types of the codec's integer path. */
export function isHtj2kDataType(dataType: DataType) {
  return (
    dataType === DataType.UINT8 ||
    dataType === DataType.INT8 ||
    dataType === DataType.UINT16 ||
    dataType === DataType.INT16 ||
    dataType === DataType.UINT32 ||
    dataType === DataType.INT32
  );
}

registerCodec({
  name: "htj2k",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (!isHtj2kDataType(dataType)) {
      throw new Error(
        `htj2k supports 8-, 16- and 32-bit integer data types, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    if (chunkShape.length < 2) {
      throw new Error("htj2k requires a chunk of at least two dimensions");
    }
    const result: Configuration = {};
    if (configuration !== undefined) {
      verifyObject(configuration);
      result.xy_levels = verifyOptionalObjectProperty(
        configuration,
        "xy_levels",
        (value) => {
          const levels = verifyInt(value);
          if (levels < 0 || levels > 32) {
            throw new Error(`Invalid xy_levels: ${levels}`);
          }
          return levels;
        },
      );
      result.reversible = verifyOptionalObjectProperty(
        configuration,
        "reversible",
        verifyBoolean,
      );
      result.progression = verifyOptionalObjectProperty(
        configuration,
        "progression",
        (value) => {
          const progression = verifyString(value);
          if (!PROGRESSIONS.includes(progression)) {
            throw new Error(
              `Invalid progression: ${JSON.stringify(progression)}`,
            );
          }
          return progression;
        },
      );
      result.index = verifyOptionalObjectProperty(
        configuration,
        "index",
        verifyBoolean,
      );
    }
    return { configuration: result };
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
