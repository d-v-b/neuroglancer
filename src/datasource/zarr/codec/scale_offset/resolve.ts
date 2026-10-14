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
 * @file The `scale_offset` codec (https://github.com/zarr-developers/zarr-extensions), which
 * encodes values as `(value - offset) * scale`, e.g. to store reflectances as integers (combined
 * with the `cast_value` codec).
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
  offset: number;
  scale: number;
}

function verifyFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Expected finite number, but received: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

registerCodec({
  name: "scale_offset",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const offset =
      verifyOptionalObjectProperty(
        configuration,
        "offset",
        verifyFiniteNumber,
      ) ?? 0;
    const scale =
      verifyOptionalObjectProperty(
        configuration,
        "scale",
        verifyFiniteNumber,
      ) ?? 1;
    if (scale === 0) throw new Error("scale must be nonzero");
    if (decodedArrayInfo.dataType !== DataType.FLOAT32) {
      throw new Error(
        "scale_offset codec is only supported for float32 arrays",
      );
    }
    return {
      configuration: { offset, scale },
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
    return encodedLayout;
  },
});
