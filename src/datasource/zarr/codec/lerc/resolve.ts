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
 * @file The `imagecodecs_lerc` array-to-bytes codec, which has no configuration:
 * each chunk is one LERC 2 blob, as imagecodecs' `lerc_decode(masks=False)` reads
 * it. A blob of height `h` and width `w` fills a chunk whose shape ends in
 * `[h, w]`; with `d` values per pixel, `[h, w, d]`; and with `b` bands,
 * `[b, h, w]` or `[b, h, w, d]`. All other chunk dimensions must be 1. A float64
 * array is shown as float32, its values rounded to nearest.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject } from "#src/util/json.js";

export type Configuration = Record<string, never>;

registerCodec({
  name: "imagecodecs_lerc",
  kind: CodecKind.arrayToBytes,
  decodesFloat64AsFloat32: true,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    const { dataType } = decodedArrayInfo;
    if (dataType === DataType.UINT64) {
      throw new Error("imagecodecs_lerc: LERC has no uint64 values");
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
