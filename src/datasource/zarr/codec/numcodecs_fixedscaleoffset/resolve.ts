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
 * @file The `numcodecs.fixedscaleoffset` array-to-array codec, as zarr-python 3
 * names numcodecs' `FixedScaleOffset`
 * (`zarr.codecs.numcodecs.FixedScaleOffset`): an element is stored as
 * `(value - offset) * scale`, rounded, in the data type `astype`. So decoding
 * gives `stored / scale + offset`, cast to the array's data type. A float64
 * array, which is how this codec is usually written, is shown as float32 (see
 * `ArrayToArrayCodecResolver.decodesFloat64AsFloat32`).
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyFiniteFloat,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

export interface Configuration {
  scale: number;
  offset: number;
}

/** The NumPy type strings Neuroglancer has a data type for, without 64-bit integers. */
const NUMPY_TYPES = new Map<string, DataType>([
  ["u1", DataType.UINT8],
  ["i1", DataType.INT8],
  ["u2", DataType.UINT16],
  ["i2", DataType.INT16],
  ["u4", DataType.UINT32],
  ["i4", DataType.INT32],
  ["f4", DataType.FLOAT32],
]);

/** The data type of a NumPy type string (the `bytes` codec handles its byte order). */
export function parseStoredType(value: string): DataType {
  const dataType = NUMPY_TYPES.get(value.replace(/^[<>|]/, ""));
  if (dataType === undefined) {
    throw new Error(`Unsupported astype: ${JSON.stringify(value)}`);
  }
  return dataType;
}

registerCodec({
  name: "numcodecs.fixedscaleoffset",
  kind: CodecKind.arrayToArray,
  changesValues: true,
  decodesFloat64AsFloat32: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    if (decodedArrayInfo.dataType === DataType.UINT64) {
      throw new Error("uint64 arrays are not supported with this codec");
    }
    const scale = verifyObjectProperty(
      configuration,
      "scale",
      verifyFiniteFloat,
    );
    const offset = verifyObjectProperty(
      configuration,
      "offset",
      verifyFiniteFloat,
    );
    const astype = verifyOptionalObjectProperty(
      configuration,
      "astype",
      verifyString,
    );
    const dataType =
      astype === undefined
        ? decodedArrayInfo.dataType
        : parseStoredType(astype);
    return {
      configuration: { scale, offset },
      encodedArrayInfo: { ...decodedArrayInfo, dataType },
    };
  },
  getDecodedArrayLayoutInfo(
    _configuration: Configuration,
    _decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    return encodedLayout;
  },
});
