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
 * @file Decodes `refkv.grib` chunks with refkv's Rust core (the vendored
 * src/third_party/refkv), in the worker: the same decoder refkv's Python
 * codec uses, so the values are the same, rounded to float32.
 */

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_grib/resolve.js";
import { decodeGrib } from "#src/third_party/refkv/core.js";

registerCodec({
  name: "refkv.grib",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { chunkShape } = decodedArrayInfo;
    const values = (await decodeGrib(
      encoded,
      configuration.raw,
      chunkShape,
      "float32",
    )) as Float32Array<ArrayBuffer>;
    const expected = chunkShape.reduce((a, b) => a * b, 1);
    if (values.length !== expected) {
      throw new Error(
        `refkv.grib: a chunk decodes to ${values.length} values, not ${expected}`,
      );
    }
    return values;
  },
});
