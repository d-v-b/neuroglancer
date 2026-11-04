/**
 * @license
 * Copyright 2023 Google Inc.
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

import { describe, expect, test } from "vitest";
import { decodeDicomRle } from "#src/datasource/zarr/codec/dicomrle/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import "#src/datasource/zarr/codec/dicomrle/resolve.js";
import { DataType } from "#src/util/data_type.js";

/** A frame of `segments`, each a PackBits stream, with their 64-byte header. */
function frame(segments: number[][]): Uint8Array {
  const header = new Uint32Array(16);
  header[0] = segments.length;
  let at = 64;
  segments.forEach((s, i) => {
    header[i + 1] = at;
    at += s.length;
  });
  return new Uint8Array([...new Uint8Array(header.buffer), ...segments.flat()]);
}

describe("decodeDicomRle", () => {
  test("reads literal runs, replicate runs and no-ops", () => {
    // 2 literals, 128 (a no-op), then 1 repeated 3 times (254 = -2)
    const out = decodeDicomRle(frame([[1, 7, 8, 128, 254, 9]]), 5, 1);
    expect(Array.from(out)).toEqual([7, 8, 9, 9, 9]);
  });

  test("puts the first segment in the most significant byte", () => {
    const out = decodeDicomRle(
      frame([
        [1, 1, 2],
        [1, 3, 4],
      ]),
      2,
      2,
    );
    expect(Array.from(out)).toEqual([3, 1, 4, 2]); // 0x0103, 0x0204, little-endian
  });

  test("gives planar samples, as imagecodecs' dicomrle_decode does", () => {
    const out = decodeDicomRle(
      frame([
        [1, 1, 2],
        [1, 3, 4],
        [1, 5, 6],
      ]),
      6,
      1,
    );
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("refuses a stream without a header", () => {
    expect(() => decodeDicomRle(new Uint8Array(8), 1, 1)).toThrow("no header");
  });

  test("refuses a number of segments that the elements do not divide", () => {
    expect(() => decodeDicomRle(frame([[0, 1]]), 1, 2)).toThrow(
      "1 segments for 1 elements of 2 bytes",
    );
  });

  test("refuses a segment that ends early", () => {
    expect(() => decodeDicomRle(frame([[0, 1]]), 2, 1)).toThrow(
      "ends 1 bytes short",
    );
  });

  test("refuses a dtype other than the array's", () => {
    expect(() =>
      parseCodecChainSpec(
        [{ name: "imagecodecs_dicomrle", configuration: { dtype: "<u2" } }],
        { dataType: DataType.UINT8, chunkShape: [1, 1] },
      ),
    ).toThrow("is not the array's uint8");
  });
});
