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
import type { Configuration } from "#src/datasource/zarr/codec/packbits/resolve.js";

/**
 * Decodes one PackBits stream. With `sizeHint`, the output is first allocated
 * with that size; it grows as needed, and is returned whatever its size, which
 * the next codec of the chain checks. Like imagecodecs, it ignores a final 0
 * byte that has no literal after it, as well as the code -128 (the byte 128).
 */
export function decodePackBits(
  encoded: Uint8Array,
  sizeHint?: number,
): Uint8Array<ArrayBuffer> {
  let out = new Uint8Array(Math.max(16, sizeHint ?? encoded.length * 2));
  let outLength = 0;
  const ensure = (n: number) => {
    if (outLength + n <= out.length) return;
    let size = out.length * 2;
    while (size < outLength + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(out.subarray(0, outLength));
    out = grown;
  };
  const end = encoded.length;
  for (let i = 0; i < end; ) {
    const code = encoded[i++];
    if (code === 128) continue;
    if (code < 128) {
      const n = code + 1;
      if (i + n > end) {
        if (code === 0) break;
        throw new Error(
          `imagecodecs_packbits: a literal of ${n} bytes at offset ${i - 1} ` +
            `overruns the stream of ${end} bytes`,
        );
      }
      ensure(n);
      out.set(encoded.subarray(i, i + n), outLength);
      outLength += n;
      i += n;
    } else {
      if (i === end) {
        throw new Error(
          `imagecodecs_packbits: a run at offset ${i - 1} has no byte to repeat`,
        );
      }
      const n = 257 - code;
      ensure(n);
      out.fill(encoded[i++], outLength, outLength + n);
      outLength += n;
    }
  }
  return outLength === out.length ? out : out.slice(0, outLength);
}

registerCodec({
  name: "imagecodecs_packbits",
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    signal.throwIfAborted();
    return decodePackBits(encoded, configuration.decodedSize);
  },
});
