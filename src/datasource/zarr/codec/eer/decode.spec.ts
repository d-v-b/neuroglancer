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
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { decodeEer } from "#src/datasource/zarr/codec/eer/decode.js";
import "#src/datasource/zarr/codec/eer/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const config = (shape: number[], extra = {}) => [
  {
    name: "imagecodecs_eer",
    configuration: { shape, skipbits: 7, horzbits: 2, vertbits: 2, ...extra },
  },
];

// Encoded by hand, imagecodecs having no `eer_encode`, with random sub-pixel
// bits. `expected` is what imagecodecs 2026.8.16's `eer_decode` returns.
const CASES = [
  {
    name: "7, 2, 2: the last pixel ends the stream",
    shape: [4, 8],
    skipBits: 7,
    horzBits: 2,
    vertBits: 2,
    encoded: "gR+ggxUJ",
    expected: "AAEAAAABAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAE=",
  },
  {
    name: "7, 2, 2: a run reaches the end",
    shape: [4, 8],
    skipBits: 7,
    horzBits: 2,
    vertBits: 2,
    encoded: "gCeggxcA",
    expected: "AQAAAAABAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAA=",
  },
  {
    name: "7, 2, 2: runs of all ones",
    shape: [64, 8],
    skipBits: 7,
    horzBits: 2,
    vertBits: 2,
    encoded: "/7/rAQjjvyUXAA==",
    expected:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAA=",
  },
  {
    name: "8, 2, 2",
    shape: [32, 32],
    skipBits: 8,
    horzBits: 2,
    vertBits: 2,
    encoded:
      "Ap+BGSySCDKBLW/wPy+QF5WQBtpII5+AVSVwBqGSHhXiDRQwINlAAwVgGTtACW5RAEziBRtgCgrEAowFBwA=",
    expected:
      "AAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAABAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAEAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAABAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAQABAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAA==",
  },
  {
    name: "7, 1, 1, wide",
    shape: [8, 50],
    skipBits: 7,
    horzBits: 1,
    vertBits: 1,
    encoded: "3LMiFihApPHNkGcA",
    expected:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAABAAABAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  },
  {
    name: "4, 3, 3",
    shape: [16, 16],
    skipBits: 4,
    horzBits: 3,
    vertBits: 3,
    encoded:
      "0AtoMJCxAKj8iy99nEEJWSlI1vMI1nRh3DnV7DDNE6ZMUUUWLESgjwXx0y6sYqFC/AKnIIVOZAHrBXAjIy6EbQUA",
    expected:
      "AQAAAQAAAAAAAAEBAAEBAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAEAAAEAAQABAAABAAAAAAABAQAAAAAAAAEAAAAAAAAAAAAAAAABAQAAAAEAAQAAAAAAAAABAAAAAQAAAAEBAAAAAQABAAABAAEAAQABAQEAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAABAAABAAAAAAAAAAAAAAEAAQEAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAABAAABAAAAAAAAAAAAAAEAAAAAAQEAAAAAAAAAAAAAAAAAAAEBAAAAAQAAAAAAAAAAAQAAAQAAAAAAAAEAAAAAAA==",
  },
  {
    name: "4, 4, 4",
    shape: [4, 4],
    skipBits: 4,
    horzBits: 4,
    vertBits: 4,
    encoded: "UC+BE0yQAwA=",
    expected: "AQAAAQAAAAEAAAAAAQAAAA==",
  },
  {
    name: "14, 1, 1",
    shape: [30, 30],
    skipBits: 14,
    horzBits: 1,
    vertBits: 1,
    encoded: "g8MAAA==",
    expected:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
  },
  {
    name: "7, 2, 2: an event ending the stream is not read",
    shape: [8, 8],
    skipBits: 7,
    horzBits: 2,
    vertBits: 2,
    encoded: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    expected:
      "AQEBAQEBAQEBAQEBAQEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  },
];

test("decodes as imagecodecs does", async () => {
  for (const {
    shape,
    skipBits,
    horzBits,
    vertBits,
    encoded,
    expected,
  } of CASES) {
    const decoded = await decodeArray(
      parseCodecChainSpec(
        [
          {
            name: "imagecodecs_eer",
            configuration: {
              shape,
              skipbits: skipBits,
              horzbits: horzBits,
              vertbits: vertBits,
              superres: 0,
            },
          },
        ],
        { dataType: DataType.UINT8, chunkShape: [1, ...shape] },
      ),
      fromBase64(encoded),
      new AbortController().signal,
    );
    expect(decoded).toEqual(fromBase64(expected));
  }
});

test("accepts a stream of an odd number of bytes, which imagecodecs refuses", () => {
  // Events at 0, 5 and 20, of 11 bits each, in 5 bytes. The script checked that
  // `eer_decode` refuses this, with a value error.
  const encoded = Uint8Array.of(0x00, 0x20, 0x80, 0x03, 0x00);
  const expected = new Uint8Array(32);
  expected[0] = expected[5] = expected[20] = 1;
  expect(decodeEer(encoded, 32, 7, 4)).toEqual(expected);
});

test("rejects other data types", () => {
  expect(() =>
    parseCodecChainSpec(config([2, 2]), {
      dataType: DataType.UINT16,
      chunkShape: [2, 2],
    }),
  ).toThrow(/supports the uint8 data type, not uint16/);
});

test("rejects a shape other than the chunk's", () => {
  expect(() =>
    parseCodecChainSpec(config([2, 3]), {
      dataType: DataType.UINT8,
      chunkShape: [2, 2],
    }),
  ).toThrow(
    /an image of shape \[2, 3\] does not fill a chunk of shape \[2, 2\]/,
  );
});

test("rejects a chunk of more than one image", () => {
  expect(() =>
    parseCodecChainSpec(config([2, 2]), {
      dataType: DataType.UINT8,
      chunkShape: [2, 2, 2],
    }),
  ).toThrow(/does not fill a chunk of shape \[2, 2, 2\]/);
});

test("rejects codes imagecodecs does not read", () => {
  expect(() =>
    parseCodecChainSpec(config([2, 2], { skipbits: 3 }), {
      dataType: DataType.UINT8,
      chunkShape: [2, 2],
    }),
  ).toThrow(/unsupported skipbits 3, horzbits 2 and vertbits 2/);
});

test("rejects a superres other than 0", () => {
  expect(() =>
    parseCodecChainSpec(config([2, 2], { superres: 1 }), {
      dataType: DataType.UINT8,
      chunkShape: [2, 2],
    }),
  ).toThrow(/Only a superres of 0 is supported/);
});

test("rejects a code that steps past the end of the image", () => {
  // A code of all ones, 127, in an image of 32 pixels.
  expect(() =>
    decodeEer(Uint8Array.of(0xff, 0xff, 0xff, 0xff), 32, 7, 4),
  ).toThrow(/a code at bit 0 steps past the end of an image of 32 pixels/);
});
