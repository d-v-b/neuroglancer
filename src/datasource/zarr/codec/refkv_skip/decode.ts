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

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_skip/resolve.js";

/** `encoded` without its first `length` bytes, which it must have. */
export function skip(
  encoded: Uint8Array<ArrayBuffer>,
  length: number,
): Uint8Array<ArrayBuffer> {
  if (encoded.length < length) {
    throw new Error(
      `refkv.skip: a chunk of ${encoded.length} bytes, fewer than the ${length} it skips`,
    );
  }
  return encoded.subarray(length);
}

registerCodec({
  name: "refkv.skip",
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    signal;
    return skip(encoded, configuration.length);
  },
});
