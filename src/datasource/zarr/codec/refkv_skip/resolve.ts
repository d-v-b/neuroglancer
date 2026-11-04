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
 * @file The `refkv.skip` bytes-to-bytes codec, configuration `{"length": k}` or
 * `{"length": k, "keep": n}`: decoding drops a chunk's first `k` bytes and, with
 * `keep`, any after the `n` that follow them (refkv's spec/zarrify/npy.md,
 * section 4.4). refkv zarrifies a deflated member of a `.npz` archive as one
 * chunk that `gzip` decodes to the member's NPY header and data; this codec,
 * after `gzip` in decoding, drops the header. A compressed FITS file's array is
 * one chunk, the whole file, and `keep` stops at the array's end
 * (spec/zarrify/fits.md, section 2.1).
 */

import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  length: number;
  keep?: number;
}

function verifySize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Expected non-negative integer, but received: ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

registerCodec({
  name: "refkv.skip",
  kind: CodecKind.bytesToBytes,
  resolve(
    configuration: unknown,
    decodedSize: number | undefined,
  ): { configuration: Configuration; encodedSize: number | undefined } {
    verifyObject(configuration);
    const length = verifyObjectProperty(configuration, "length", verifySize);
    const keep = verifyOptionalObjectProperty(
      configuration,
      "keep",
      verifySize,
    );
    if (keep !== undefined) {
      // what follows the kept bytes is of no size the codec knows
      return { configuration: { length, keep }, encodedSize: undefined };
    }
    return {
      configuration: { length },
      encodedSize: decodedSize === undefined ? undefined : decodedSize + length,
    };
  },
});
