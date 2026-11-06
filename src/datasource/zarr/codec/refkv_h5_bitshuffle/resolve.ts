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
 * @file The `refkv.h5_bitshuffle` bytes-to-bytes codec: chunks of HDF5's
 * bitshuffle filter (32008), with or without its LZ4, as DECTRIS detectors
 * write them (refkv's spec/zarrify/hdf5.md, "The codec refkv.h5_bitshuffle").
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  elementSize: number;
  blockSize: number;
  lz4: boolean;
}

function positive(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(
      `Expected positive integer, but received: ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

registerCodec({
  name: "refkv.h5_bitshuffle",
  kind: CodecKind.bytesToBytes,
  resolve(configuration: unknown): {
    configuration: Configuration;
    encodedSize?: number;
  } {
    verifyObject(configuration);
    const elementSize = verifyObjectProperty(
      configuration,
      "elementsize",
      positive,
    );
    const blockSize = verifyObjectProperty(
      configuration,
      "block_size",
      positive,
    );
    const lz4 = verifyObjectProperty(configuration, "compression", (value) => {
      if (value !== "lz4" && value !== "none") {
        throw new Error(
          `Expected "lz4" or "none", but received: ${JSON.stringify(value)}`,
        );
      }
      return value === "lz4";
    });
    return { configuration: { elementSize, blockSize, lz4 } };
  },
});
