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
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import "#src/datasource/zarr/codec/packints/decode.js";
import "#src/datasource/zarr/codec/packints/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function decodeChunk(
  codecs: unknown,
  info: CodecArrayInfo,
  encoded: Uint8Array<ArrayBuffer>,
  float64 = false,
) {
  return decodeArray(
    parseCodecChainSpec(codecs, info, float64),
    encoded,
    new AbortController().signal,
  );
}

// Written by imagecodecs 2026.8.16's `packints_encode`, which `packints_decode`
// reads back. `expected` is little-endian.
const CASES = [
  {
    name: "1-bit, width a multiple of 8",
    shape: [3, 16],
    bitsPerSample: 1,
    runLength: 16,
    encoded: "tglRqqCN",
    expected:
      "AQABAQABAQAAAAAAAQAAAQABAAEAAAABAQABAAEAAQABAAEAAAAAAAEAAAABAQAB",
  },
  {
    name: "1-bit, rows restart on a byte",
    shape: [4, 13],
    bitsPerSample: 1,
    runLength: 13,
    encoded: "hIhoUEYIOFg=",
    expected:
      "AQAAAAABAAABAAAAAQABAQABAAAAAAEAAQAAAQAAAAEBAAAAAAABAAABAQEAAAAAAQABAQ==",
  },
  {
    name: "1-bit, [h, w, s]",
    shape: [2, 5, 3],
    bitsPerSample: 1,
    runLength: 15,
    encoded: "5baUkA==",
    expected: "AQEBAAABAAEBAAEBAAEBAQAAAQABAAABAAABAAAA",
  },
  {
    name: "1-bit, leading dimensions of 1",
    shape: [1, 1, 3, 7],
    bitsPerSample: 1,
    runLength: 7,
    encoded: "6gJe",
    expected: "AQEBAAEAAQAAAAAAAAEAAQABAQEB",
  },
  {
    name: "12-bit, even width",
    shape: [3, 6],
    bitsPerSample: 12,
    runLength: 6,
    encoded: "iyWcv95hPi0t+lNVo38niMellHESoHpQP4TD",
    expected: "sgicBf0LYQ7iAy0NpQ9VAzcKJw+MCKUHRwkSAQcKUAr4A8ME",
  },
  {
    name: "12-bit, odd width restarts on a byte",
    shape: [4, 5],
    bitsPerSample: 12,
    runLength: 5,
    encoded: "pjQWVhno2vCLP5lNMLVnYLyizELXU22wft5rcsvewrA=",
    expected: "YwoWBGEF6AmvDbMImQ/TBLUAdgbKC8wCLQRTB9sG7QdrDiwH3gsrDA==",
  },
  {
    name: "12-bit, [h, w, s]",
    shape: [2, 3, 3],
    bitsPerSample: 12,
    runLength: 9,
    encoded: "HJUlX+r/r4MaElP4jDB6FyGfOeax7PtQyF7TAA==",
    expected: "yQElBf4F/wr4ChoDJQH4A8MIoQchB/MJ5gkeC/sMDAVeCDAN",
  },
  {
    name: "12-bit, one sample",
    shape: [1, 1],
    bitsPerSample: 12,
    runLength: 1,
    encoded: "q8A=",
    expected: "vAo=",
  },
];

test("decodes the streams imagecodecs writes", async () => {
  for (const { shape, bitsPerSample, runLength, encoded, expected } of CASES) {
    const bytes = fromBase64(expected);
    const values = bitsPerSample === 1 ? bytes : new Uint16Array(bytes.buffer);
    const encodedBytes = fromBase64(encoded);
    const chain = parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: bitsPerSample, runlen: runLength },
        },
      ],
      {
        dataType: bitsPerSample === 1 ? DataType.UINT8 : DataType.UINT16,
        chunkShape: shape,
      },
    );
    expect(chain.encodedSize[0]).toBe(encodedBytes.length);
    const decoded = await decodeArray(
      chain,
      encodedBytes,
      new AbortController().signal,
    );
    expect(decoded).toEqual(values);
  }
});

test("rejects other sample sizes", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 10, runlen: 4 },
        },
      ],
      { dataType: DataType.UINT16, chunkShape: [2, 4] },
    ),
  ).toThrow(/Only 1 and 12 are supported/);
});

test("rejects 1-bit samples of another data type", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 1, runlen: 4 },
        },
      ],
      { dataType: DataType.UINT16, chunkShape: [2, 4] },
    ),
  ).toThrow(/1-bit samples are uint8, not uint16/);
});

test("rejects 12-bit samples of another data type", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 12, runlen: 4 },
        },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow(/12-bit samples are uint16, not uint8/);
});

test("rejects a runlen that is not positive", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 1, runlen: 0 },
        },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow(/Expected positive integer/);
});

test("rejects a runlen that does not divide the chunk", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 1, runlen: 3 },
        },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow(/runlen 3 does not divide the 8 samples/);
});

test("rejects a chunk of the wrong size", async () => {
  await expect(
    decodeChunk(
      [
        {
          name: "imagecodecs_packints",
          configuration: { bitspersample: 12, runlen: 5 },
        },
      ],
      { dataType: DataType.UINT16, chunkShape: [2, 5] },
      new Uint8Array(15),
    ),
  ).rejects.toThrow(/chunk is 15 bytes, but 2 runs of 8 bytes are 16 bytes/);
});
