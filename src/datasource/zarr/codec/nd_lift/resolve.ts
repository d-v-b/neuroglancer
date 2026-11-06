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
 * @file The nd-image-codecs `nd_lift` array-to-array codec
 * (https://github.com/fideus-labs/nd-image-codecs): reversible integer lifting (delta, Haar or 5/3) along
 * the non-spatial axes of a chunk. Encoding widens integer samples of up to 32 bits to int32; decoding
 * restores the array's own data type.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  parseArray,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

export interface Transform {
  axis?: string;
  // The axis's index into the chunk shape that the decoder sees.
  dimension: number;
  kind: "delta" | "haar" | "lift53";
  levels?: number;
  group?: number;
}

export interface Configuration {
  version: string;
  transforms: Transform[];
}

const KINDS = ["delta", "haar", "lift53"];

registerCodec({
  name: "nd_lift",
  kind: CodecKind.arrayToArray,
  changesValues: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (
      dataType !== DataType.UINT8 &&
      dataType !== DataType.INT8 &&
      dataType !== DataType.UINT16 &&
      dataType !== DataType.INT16 &&
      dataType !== DataType.UINT32 &&
      dataType !== DataType.INT32
    ) {
      throw new Error(
        `nd_lift supports 8-, 16- and 32-bit integer data types, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    verifyObject(configuration);
    const version = verifyObjectProperty(
      configuration,
      "version",
      verifyString,
    );
    if (version !== "0.1") {
      throw new Error(
        `Unsupported nd_lift version: ${JSON.stringify(version)}`,
      );
    }
    const rank = chunkShape.length;
    verifyObjectProperty(configuration, "transforms", (value) =>
      parseArray(value, (entry): Transform => {
        verifyObject(entry);
        const dimension = verifyObjectProperty(entry, "dimension", verifyInt);
        if (dimension < 0 || dimension >= rank) {
          throw new Error(
            `nd_lift dimension ${dimension} is outside [0, ${rank})`,
          );
        }
        const kind = verifyObjectProperty(entry, "kind", verifyString);
        if (!KINDS.includes(kind)) {
          throw new Error(`Unsupported nd_lift kind: ${JSON.stringify(kind)}`);
        }
        return {
          axis: verifyOptionalObjectProperty(entry, "axis", verifyString),
          dimension,
          kind: kind as Transform["kind"],
          levels: verifyOptionalObjectProperty(entry, "levels", verifyInt),
          group: verifyOptionalObjectProperty(entry, "group", verifyInt),
        };
      }),
    );
    return {
      // The WebAssembly decoder parses the original JSON, so keep every member as written.
      configuration: configuration as unknown as Configuration,
      encodedArrayInfo: { ...decodedArrayInfo, dataType: DataType.INT32 },
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
      throw new Error("nd_lift is not supported before a transpose codec");
    }
    return encodedLayout;
  },
});
