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
 * @file The `imagecodecs_lz4h5` bytes-to-bytes codec: chunks of HDF5's LZ4
 * filter (32004), which refkv's HDF5 and IMS profiles name. A chunk records
 * its own lengths, so the codec has nothing to configure.
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";

export type Configuration = object;

registerCodec({
  name: "imagecodecs_lz4h5",
  kind: CodecKind.bytesToBytes,
  resolve(configuration: unknown): {
    configuration: Configuration;
    encodedSize?: number;
  } {
    configuration;
    return { configuration: {} };
  },
});
