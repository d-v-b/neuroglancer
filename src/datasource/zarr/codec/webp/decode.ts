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

import { decodeWebp } from "#src/async_computation/decode_webp_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/webp/resolve.js";
import type { DecodedWebp } from "#src/util/webp.js";

// Checks that a decoded image fills a chunk, and returns the chunk's samples.
export function webpChunkArray(
  chunkShape: readonly number[],
  decoded: DecodedWebp,
): Uint8Array<ArrayBuffer> {
  const { width, height, rgba } = decoded;
  const rank = chunkShape.length;
  const samples = chunkShape[rank - 1];
  if (chunkShape[rank - 3] !== height || chunkShape[rank - 2] !== width) {
    throw new Error(
      `WebP image of height ${height} and width ${width} does not fill a ` +
        `chunk of shape [${chunkShape.join(", ")}]`,
    );
  }
  if (samples === 4) return rgba;
  const rgb = new Uint8Array(height * width * 3);
  for (let i = 0, o = 0, n = rgba.length; i < n; i += 4, o += 3) {
    rgb[o] = rgba[i];
    rgb[o + 1] = rgba[i + 1];
    rgb[o + 2] = rgba[i + 2];
  }
  return rgb;
}

registerCodec({
  name: "imagecodecs_webp",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    configuration;
    const decoded = await requestAsyncComputation(
      decodeWebp,
      signal,
      [encoded.buffer],
      encoded,
    );
    return webpChunkArray(decodedArrayInfo.chunkShape, decoded);
  },
});
