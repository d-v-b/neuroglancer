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
import { unpackBits } from "#src/datasource/zarr/codec/packbits/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import "#src/datasource/zarr/codec/packbits/resolve.js";
import { DataType } from "#src/util/data_type.js";

describe("packbits", () => {
  test("reads each element's bits, least significant first", () => {
    // refkv's pack(), which zarr-extensions' order defines
    expect(Array.from(unpackBits(Uint8Array.of(0x21, 0x0f), 3, 4, 0))).toEqual([
      1, 2, 15,
    ]);
    expect(Array.from(unpackBits(Uint8Array.of(0b101), 3, 1, 0))).toEqual([
      1, 0, 1,
    ]);
    // bits that cross a byte
    expect(
      Array.from(unpackBits(Uint8Array.of(0x3f, 0x10, 0xa8), 4, 6, 0)),
    ).toEqual([0x3f, 0, 1, 0x2a]);
    // shifted to first_bit
    expect(Array.from(unpackBits(Uint8Array.of(0x21), 2, 4, 2))).toEqual([
      4, 8,
    ]);
  });

  test("refuses a chunk shorter than its elements", () => {
    expect(() => unpackBits(Uint8Array.of(1), 3, 4, 0)).toThrow(
      "fewer than the 2 of 3 elements of 4 bits",
    );
  });

  function resolve(configuration: object, elementBits?: number) {
    return parseCodecChainSpec([{ name: "packbits", configuration }], {
      dataType: DataType.UINT8,
      chunkShape: [3],
      elementBits,
    });
  }

  test("takes a bool's one bit and a uint8's eight as the defaults", () => {
    expect(resolve({}, 1)[1].configuration).toEqual({
      paddingEncoding: 0,
      firstBit: 0,
      numBits: 1,
    });
    expect(resolve({ last_bit: 3 })[1].configuration).toEqual({
      paddingEncoding: 0,
      firstBit: 0,
      numBits: 4,
    });
    expect(resolve({ last_bit: 3 }).encodedSize[0]).toBe(2);
  });

  test("refuses a bit range outside the data type", () => {
    expect(() => resolve({ last_bit: 3 }, 1)).toThrow("not a range");
  });

  test("refuses an unknown padding encoding", () => {
    expect(() => resolve({ padding_encoding: "other" })).toThrow(
      "Invalid padding_encoding",
    );
  });

  test("refuses another data type", () => {
    expect(() =>
      parseCodecChainSpec([{ name: "packbits" }], {
        dataType: DataType.UINT16,
        chunkShape: [3],
      }),
    ).toThrow("packbits supports uint8 and bool, not uint16");
  });
});
