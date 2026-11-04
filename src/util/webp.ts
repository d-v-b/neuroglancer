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
 * @file WebP decoding with `@jsquash/webp`, a wasm build of libwebp's
 * `WebPDecodeRGBA`: unassociated alpha, 255 for an image without any, and no
 * color management, unlike decoding with a canvas.
 */

import decode from "@jsquash/webp/decode.js";

export interface DecodedWebp {
  width: number;
  height: number;
  // Samples R, G, B, A, by pixel, row-major.
  rgba: Uint8Array<ArrayBuffer>;
}

export async function decodeWebpRgba(
  encoded: Uint8Array<ArrayBuffer>,
): Promise<DecodedWebp> {
  // The package's type says ArrayBuffer, but the decoder reads any byte view,
  // and copying the buffer would also have to respect a view's bounds.
  const { width, height, data } = await decode(
    encoded as unknown as ArrayBuffer,
  );
  return {
    width,
    height,
    rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
  };
}
