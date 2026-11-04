/**
 * @license
 * Copyright 2023 Google Inc.
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
 * @file The `imagecodecs_dicomrle` array-to-bytes codec: a chunk is one DICOM
 * RLE frame (PS3.5 Annex G): a 64-byte header of little-endian u32s, the number
 * of segments then their offsets, followed by the segments, each a PackBits
 * stream of one byte of each sample, most significant byte first. The samples'
 * values are planar, a chunk's first axis the samples, as imagecodecs'
 * `dicomrle_decode` gives them. `dtype` must name the array's data type.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

export type Configuration = Record<string, never>;

const DATA_TYPES: Record<string, DataType> = {
  u1: DataType.UINT8,
  i1: DataType.INT8,
  u2: DataType.UINT16,
  i2: DataType.INT16,
  u4: DataType.UINT32,
  i4: DataType.INT32,
};

registerCodec({
  name: "imagecodecs_dicomrle",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    verifyObject(configuration);
    const dtype = verifyObjectProperty(configuration, "dtype", verifyString);
    const dataType = DATA_TYPES[dtype.replace(/^[<>|=]/, "")];
    if (dataType !== decodedArrayInfo.dataType) {
      throw new Error(
        `imagecodecs_dicomrle: dtype ${JSON.stringify(dtype)} is not the array's ` +
          `${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
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
