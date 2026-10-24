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
 * @file The `refkv.fits_tiles` array-to-bytes codec: a chunk of a
 * tile-compressed FITS image (RICE_1, GZIP_1, GZIP_2 or NOCOMPRESS tiles, and
 * their quantization), as refkv virtualizes such images (refkv's
 * spec/virtualize/fits.md, section 3.3): a prefix of per-tile records, then
 * the tiles' streams. The configuration (the compression, its parameters,
 * ZBITPIX, the image and tile shapes, the quantization and dither seed) is
 * passed to refkv's decoder as it is.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject } from "#src/util/json.js";

export interface Configuration {
  /** The configuration as the array's metadata gives it. */
  raw: unknown;
}

// FITS images of BITPIX 8, 16, 32 and -32; Neuroglancer has no 64-bit
// integer or float data type for BITPIX 64 and -64
const DATA_TYPES = new Set([
  DataType.UINT8,
  DataType.INT16,
  DataType.INT32,
  DataType.FLOAT32,
]);

registerCodec({
  name: "refkv.fits_tiles",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    verifyObject(configuration);
    if (!DATA_TYPES.has(decodedArrayInfo.dataType)) {
      throw new Error(
        `refkv.fits_tiles: a FITS image is not ${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
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
