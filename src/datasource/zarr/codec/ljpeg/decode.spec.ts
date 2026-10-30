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

import { expect, test } from "vitest";
import { checkLosslessJpegChunk } from "#src/datasource/zarr/codec/ljpeg/decode.js";
import { DataType } from "#src/util/data_type.js";

test("decoded images fill chunks of their data type", () => {
  for (const [dataType, chunkShape, decoded] of [
    // A VSI tile: one RGB tile of a 512 x 512 x 3 chunk, behind z and t.
    [
      DataType.UINT8,
      [1, 1, 512, 512, 3],
      { width: 512, height: 512, numComponents: 3, bitsPerSample: 8 },
    ],
    [
      DataType.UINT8,
      [23, 37],
      { width: 37, height: 23, numComponents: 1, bitsPerSample: 2 },
    ],
    [
      DataType.UINT16,
      [1, 23, 37],
      { width: 37, height: 23, numComponents: 1, bitsPerSample: 12 },
    ],
    [
      DataType.UINT16,
      [23, 37, 4],
      { width: 37, height: 23, numComponents: 4, bitsPerSample: 16 },
    ],
  ] as const) {
    checkLosslessJpegChunk(dataType, chunkShape, decoded);
  }
});

test("rejects a chunk the image does not fill", () => {
  expect(() =>
    checkLosslessJpegChunk(DataType.UINT8, [1, 37, 23, 3], {
      width: 37,
      height: 23,
      numComponents: 3,
      bitsPerSample: 8,
    }),
  ).toThrow(
    /^Lossless JPEG image of shape \[23, 37, 3\] .* does not fill a chunk/,
  );
});

test("rejects samples of another data type", () => {
  expect(() =>
    checkLosslessJpegChunk(DataType.UINT8, [23, 37], {
      width: 37,
      height: 23,
      numComponents: 1,
      bitsPerSample: 12,
    }),
  ).toThrow(/12-bit samples does not match data type uint8/);
});
