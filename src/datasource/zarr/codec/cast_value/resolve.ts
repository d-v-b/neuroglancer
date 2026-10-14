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
 * @file The `cast_value` codec (https://github.com/zarr-developers/zarr-extensions), which stores
 * values with a different data type, with special values (e.g. NaN) mapped by `scalar_map`.
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
  verifyEnumString,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  /**
   * Pairs `[encoded, decoded]` of values mapped when decoding.
   */
  decodeMap: [number, number][];
}

/**
 * Parses a scalar of a `scalar_map`: a number, or "NaN", "Infinity", or "-Infinity".
 */
export function parseCastScalar(value: unknown): number {
  if (typeof value === "number") return value;
  switch (value) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
  }
  throw new Error(`Unsupported scalar: ${JSON.stringify(value)}`);
}

const SUPPORTED_DATA_TYPES = [
  DataType.UINT8,
  DataType.INT8,
  DataType.UINT16,
  DataType.INT16,
  DataType.UINT32,
  DataType.INT32,
  DataType.FLOAT32,
];

registerCodec({
  name: "cast_value",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const dataType = verifyObjectProperty(configuration, "data_type", (x) =>
      verifyEnumString(x, DataType, /^[a-z0-9]+$/),
    );
    for (const t of [dataType, decodedArrayInfo.dataType]) {
      if (!SUPPORTED_DATA_TYPES.includes(t)) {
        throw new Error(
          `cast_value codec does not support data type ${DataType[t].toLowerCase()}`,
        );
      }
    }
    const decodeMap =
      verifyOptionalObjectProperty(configuration, "scalar_map", (map) => {
        verifyObject(map);
        return (
          verifyOptionalObjectProperty(map, "decode", (pairs) =>
            parseArray(pairs, (pair): [number, number] => {
              if (!Array.isArray(pair) || pair.length !== 2) {
                throw new Error(
                  `Expected [encoded, decoded] pair, but received: ${JSON.stringify(pair)}`,
                );
              }
              return [parseCastScalar(pair[0]), parseCastScalar(pair[1])];
            }),
          ) ?? []
        );
      }) ?? [];
    return {
      configuration: { decodeMap },
      encodedArrayInfo: { dataType, chunkShape: decodedArrayInfo.chunkShape },
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    decodedArrayInfo;
    return encodedLayout;
  },
});
