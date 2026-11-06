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
 * @file The `imagecodecs_lzf` bytes-to-bytes codec, with `header: false`: a
 * bare LZF stream, as HDF5's LZF filter (32000) and h5py write it. refkv's
 * HDF5 profile names it. The stream does not record its decoded length, so
 * the chunk's expected length, when the chain gives one, sizes the output.
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject } from "#src/util/json.js";

export interface Configuration {
  decodedSize: number | undefined;
}

registerCodec({
  name: "imagecodecs_lzf",
  kind: CodecKind.bytesToBytes,
  resolve(
    configuration: unknown,
    decodedSize: number | undefined,
  ): { configuration: Configuration; encodedSize?: number } {
    verifyObject(configuration);
    const { header } = configuration as { header?: unknown };
    if (header !== false) {
      throw new Error(
        `imagecodecs_lzf: only header: false is supported, but received: ${JSON.stringify(header)}`,
      );
    }
    return { configuration: { decodedSize } };
  },
});
