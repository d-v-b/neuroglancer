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
 * @file The `numcodecs.shuffle` bytes-to-bytes codec, as zarr-python 3 names
 * numcodecs' `Shuffle` (`zarr.codecs.numcodecs.Shuffle`). Its encoded bytes
 * are byte 0 of every `elementsize`-byte element, then byte 1 of every
 * element, and so on. CZI Zstd1 subblocks with hi-lo packing hold exactly
 * this, with `elementsize` 2, under their zstd compression.
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  elementSize: number;
}

registerCodec({
  name: "numcodecs.shuffle",
  kind: CodecKind.bytesToBytes,
  resolve(
    configuration: unknown,
    decodedSize: number | undefined,
  ): { configuration: Configuration; encodedSize?: number } {
    verifyObject(configuration);
    const elementSize = verifyObjectProperty(
      configuration,
      "elementsize",
      (value) => {
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(
            `Expected positive integer, but received: ${JSON.stringify(value)}`,
          );
        }
        return value as number;
      },
    );
    return { configuration: { elementSize }, encodedSize: decodedSize };
  },
});
