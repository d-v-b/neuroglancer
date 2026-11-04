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
import type { Configuration } from "#src/datasource/zarr/codec/eer/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";

/**
 * Decodes one EER frame of `numPixels` pixels: a bitstream, least significant
 * bit first, of `skipBits`-bit codes. A code of all ones advances the pixel
 * index by its value. Any other code advances the index by its value, sets
 * that pixel, is followed by `subPixelBits` bits, which are ignored, and steps
 * past the pixel.
 *
 * A stream ends when the index reaches the end of the image, or when the bits
 * left do not hold more than one event: as in imagecodecs, an event that ends
 * exactly at the end of the stream is not read, so that a writer must leave at
 * least one bit after its last event. imagecodecs also refuses a stream of an
 * odd number of bytes, and some streams with nonzero codes after the end of the
 * image. This accepts both, with the pixels of the events before that end.
 */
export function decodeEer(
  encoded: Uint8Array,
  numPixels: number,
  skipBits: number,
  subPixelBits: number,
): Uint8Array<ArrayBuffer> {
  const decoded = new Uint8Array(numPixels);
  const eventBits = skipBits + subPixelBits;
  const numBits = encoded.length * 8;
  const skipMask = (1 << skipBits) - 1;
  let index = 0;
  let position = 0;
  while (index < numPixels && position + eventBits < numBits) {
    const byte = position >>> 3;
    // A code of up to 16 bits starting anywhere in a byte is within 3 bytes,
    // and those bytes are in the stream, or 0 and past any code that is used.
    const code =
      ((encoded[byte] |
        (encoded[byte + 1] << 8) |
        (encoded[byte + 2] << 16)) >>>
        (position & 7)) &
      skipMask;
    index += code;
    if (index > numPixels) {
      throw new Error(
        `imagecodecs_eer: a code at bit ${position} steps past the end of an ` +
          `image of ${numPixels} pixels`,
      );
    }
    position += skipBits;
    if (code === skipMask || index === numPixels) continue;
    decoded[index++] = 1;
    position += subPixelBits;
  }
  return decoded;
}

registerCodec({
  name: "imagecodecs_eer",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return decodeEer(
      encoded,
      decodedArrayInfo.chunkShape.reduce((a, b) => a * b, 1),
      configuration.skipBits,
      configuration.subPixelBits,
    );
  },
});
