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
 * @file Decodes `refkv.fits_tiles` chunks with refkv's Rust core (the
 * vendored src/third_party/refkv), in the worker: the same decoder refkv's
 * Python codec uses, so the pixels are the same.
 */

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_fits_tiles/resolve.js";
import { decodeFitsTiles } from "#src/third_party/refkv/core.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import { convertEndian, Endianness } from "#src/util/endian.js";

registerCodec({
  name: "refkv.fits_tiles",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { dataType, chunkShape } = decodedArrayInfo;
    const pixels = await decodeFitsTiles(
      encoded,
      configuration.raw,
      chunkShape,
    );
    const bytesPerElement = DATA_TYPE_BYTES[dataType];
    const expected = chunkShape.reduce((a, b) => a * b, 1) * bytesPerElement;
    if (pixels.byteLength !== expected) {
      throw new Error(
        `refkv.fits_tiles: a chunk decodes to ${pixels.byteLength} bytes, not ${expected}`,
      );
    }
    const data = makeDataTypeArrayView(
      dataType,
      pixels.buffer as ArrayBuffer,
      pixels.byteOffset,
      pixels.byteLength,
    );
    convertEndian(data, Endianness.LITTLE, bytesPerElement);
    return data;
  },
});
