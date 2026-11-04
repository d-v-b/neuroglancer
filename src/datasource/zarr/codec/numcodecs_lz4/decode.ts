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
import { decodeLz4Block } from "#src/util/lz4.js";

/** Reverses numcodecs' `LZ4`: its size prefix, then the block. */
export function decodeNumcodecsLz4(
  encoded: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (encoded.length < 4) {
    throw new Error(
      `numcodecs.lz4: ${encoded.length} bytes are too few for the size prefix`,
    );
  }
  const size = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  ).getUint32(0, /*littleEndian=*/ true);
  return decodeLz4Block(encoded.subarray(4), size);
}

registerCodec({
  name: "numcodecs.lz4",
  kind: CodecKind.bytesToBytes,
  async decode(_configuration: undefined, encoded, signal: AbortSignal) {
    signal.throwIfAborted();
    return decodeNumcodecsLz4(encoded);
  },
});
