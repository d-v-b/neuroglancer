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
 * @file The `imagecodecs_lzw` bytes-to-bytes codec: each chunk is one TIFF LZW
 * stream (TIFF 6.0 section 13), as imagecodecs' `lzw_encode` writes it and as
 * the tiles and strips of LZW-compressed TIFF files (Akoya QPTIFF slides among
 * them) are stored. The codec has no configuration.
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject } from "#src/util/json.js";

export type Configuration = Record<string, never>;

registerCodec({
  name: "imagecodecs_lzw",
  kind: CodecKind.bytesToBytes,
  resolve(configuration: unknown): { configuration: Configuration } {
    if (configuration !== undefined) verifyObject(configuration);
    return { configuration: {} };
  },
});
