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
 * @file LERC decoding with Esri's `lerc` package, its wasm build of the LERC C
 * library, the library imagecodecs also uses. Values of masked pixels are
 * returned as stored, as imagecodecs' `lerc_decode(masks=False)` returns them.
 */

import { decode, load } from "lerc";

export interface DecodedLerc {
  width: number;
  height: number;
  // The bands of the blob, each of `height` rows of `width` pixels.
  numBands: number;
  // The values per pixel of each band.
  depth: number;
  pixelType: "S8" | "U8" | "S16" | "U16" | "S32" | "U32" | "F32" | "F64";
  // The values of band after band, interleaved by pixel, native byte order.
  data: Uint8Array<ArrayBuffer>;
}

export async function decodeLerc(encoded: Uint8Array): Promise<DecodedLerc> {
  await load({
    locateFile: () => new URL("lerc/lerc-wasm.wasm", import.meta.url).href,
  });
  const { width, height, depthCount, pixelType, pixels } = decode(encoded, {
    returnInterleaved: true,
  });
  const data = new Uint8Array(
    pixels.reduce((size, band) => size + band.byteLength, 0),
  );
  let offset = 0;
  for (const band of pixels) {
    data.set(
      new Uint8Array(band.buffer, band.byteOffset, band.byteLength),
      offset,
    );
    offset += band.byteLength;
  }
  return {
    width,
    height,
    numBands: pixels.length,
    depth: depthCount,
    pixelType,
    data,
  };
}
