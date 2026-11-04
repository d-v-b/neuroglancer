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
 * @file The `imagecodecs_packbits` bytes-to-bytes codec, which has no
 * configuration: each chunk is one stream of TIFF PackBits run-length coding
 * ([TIFF 6.0](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf),
 * section 9), as imagecodecs' `packbits_decode` reads it. This is unrelated to
 * the zarr-extensions `packbits` codec, which packs samples of less than a byte
 * together and does no run-length coding.
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject } from "#src/util/json.js";

export interface Configuration {
  decodedSize?: number;
}

registerCodec({
  name: "imagecodecs_packbits",
  kind: CodecKind.bytesToBytes,
  resolve(
    configuration: unknown,
    decodedSize: number | undefined,
  ): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    return { configuration: { decodedSize } };
  },
});
