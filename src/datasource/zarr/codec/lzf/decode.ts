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
import type { Configuration } from "#src/datasource/zarr/codec/lzf/resolve.js";

/**
 * Decodes a bare LZF stream: a control byte below 32 is a literal run of one
 * more byte than its value; another's top 3 bits are a match's length less 2
 * (7 meaning a further byte adds to it), and its low 5 bits and the next byte
 * are the match's distance less 1.
 */
export function decodeLzf(
  encoded: Uint8Array,
  decodedSize?: number,
): Uint8Array<ArrayBuffer> {
  const bad = () => new Error("imagecodecs_lzf: a corrupt LZF stream");
  let out = new Uint8Array(decodedSize ?? Math.max(16, encoded.length * 2));
  const room = (need: number) => {
    if (need <= out.length) return;
    if (decodedSize !== undefined) {
      throw new Error(
        `imagecodecs_lzf: a stream longer than the chunk's ${decodedSize} bytes`,
      );
    }
    const grown = new Uint8Array(Math.max(need, out.length * 2));
    grown.set(out);
    out = grown;
  };
  let s = 0;
  let d = 0;
  while (s < encoded.length) {
    const control = encoded[s++];
    if (control < 32) {
      const n = control + 1;
      if (s + n > encoded.length) throw bad();
      room(d + n);
      out.set(encoded.subarray(s, s + n), d);
      s += n;
      d += n;
      continue;
    }
    let n = control >> 5;
    if (n === 7) {
      if (s >= encoded.length) throw bad();
      n += encoded[s++];
    }
    n += 2;
    if (s >= encoded.length) throw bad();
    const distance = ((control & 31) << 8) + encoded[s++] + 1;
    if (distance > d) throw bad();
    room(d + n);
    // A match may overlap what it writes, so a byte at a time.
    for (let k = 0; k < n; ++k, ++d) out[d] = out[d - distance];
  }
  if (decodedSize !== undefined && d !== decodedSize) {
    throw new Error(
      `imagecodecs_lzf: ${d} bytes, not the chunk's ${decodedSize}`,
    );
  }
  return out.slice(0, d);
}

registerCodec({
  name: "imagecodecs_lzf",
  kind: CodecKind.bytesToBytes,
  async decode(configuration: Configuration, encoded, signal: AbortSignal) {
    signal;
    return decodeLzf(encoded, configuration.decodedSize);
  },
});
