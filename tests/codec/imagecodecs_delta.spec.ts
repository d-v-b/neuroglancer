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
import "#src/datasource/zarr/codec/bytes/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { sumDifferences } from "#src/datasource/zarr/codec/delta/decode.js";
import "#src/datasource/zarr/codec/gzip/decode.js";
import "#src/datasource/zarr/codec/lzw/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import { DataType } from "#src/util/data_type.js";

// Each expected value below is imagecodecs' `delta_decode` of the input.
test("sums differences along an axis as imagecodecs does", () => {
  const encoded = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 200, 100, 50, 25, 13, 14, 15, 16,
    255, 1, 2, 3,
  ];
  const shape = [2, 3, 4];
  for (const [axis, decoded] of [
    [
      0,
      [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 201, 102, 53, 29, 18, 20, 22, 24,
        8, 11, 13, 15,
      ],
    ],
    [
      1,
      [
        1, 2, 3, 4, 6, 8, 10, 12, 15, 18, 21, 24, 200, 100, 50, 25, 213, 114,
        65, 41, 212, 115, 67, 44,
      ],
    ],
    [
      2,
      [
        1, 3, 6, 10, 5, 11, 18, 26, 9, 19, 30, 42, 200, 44, 94, 119, 13, 27, 42,
        58, 255, 0, 2, 5,
      ],
    ],
  ] as const) {
    const data = Uint8Array.from(encoded);
    sumDifferences(data, shape, axis);
    expect(Array.from(data), `axis ${axis}`).toEqual(decoded);
  }

  // Sums wrap to each data type's range, on each line apart.
  for (const [data, decoded] of [
    [new Int8Array([1, -3, 3, 100, 100, 100]), [1, -2, 1, 100, -56, 44]],
    [new Int16Array([1, -3, 3, 4, 5, 32767]), [1, -2, 1, 4, 9, -32760]],
    [new Uint16Array([1, 65535, 3, 4, 5, 65535]), [1, 0, 3, 4, 9, 8]],
    [
      new Int32Array([1, -3, 3, 4, 5, 2147483647]),
      [1, -2, 1, 4, 9, -2147483640],
    ],
    [new Uint32Array([1, 4294967295, 3, 4, 5, 4294967295]), [1, 0, 3, 4, 9, 8]],
    [
      new BigUint64Array([
        1n,
        18446744073709551615n,
        3n,
        4n,
        5n,
        18446744073709551615n,
      ]),
      [1n, 0n, 3n, 4n, 9n, 8n],
    ],
  ] as const) {
    sumDifferences(data, [2, 3], 1);
    expect(Array.from(data as any), data.constructor.name).toEqual(decoded);
  }
});

// A 2 × 4 image of `[1000, 1100, 1250, 900, 65535, 1, 2, 3]`, its rows' samples
// differenced, then compressed.
const GRAY = [1000, 1100, 1250, 900, 65535, 1, 2, 3];
// imagecodecs' `lzw_encode` of its little-endian differences
const GRAY_LZW = [
  128, 58, 0, 102, 64, 2, 88, 0, 162, 127, 63, 223, 224, 32, 0, 6, 26, 0, 128,
  128,
];

async function decode(
  codecs: unknown,
  dataType: DataType,
  chunkShape: number[],
  encoded: number[],
) {
  const spec = parseCodecChainSpec(codecs, { dataType, chunkShape });
  return Array.from(
    (await decodeArray(
      spec,
      Uint8Array.from(encoded),
      new AbortController().signal,
    )) as Uint8Array | Uint16Array,
  );
}

test("decodes the chains refkv writes for TIFF's Predictor 2", async () => {
  const delta = (axis: number) => ({
    name: "imagecodecs_delta",
    configuration: { axis, dist: 1 },
  });
  const little = { name: "bytes", configuration: { endian: "little" } };
  for (const [codecs, dataType, chunkShape, encoded, decoded] of [
    [
      [delta(1), little, { name: "refkv.tiff_lzw" }],
      DataType.UINT16,
      [2, 4],
      GRAY_LZW,
      GRAY,
    ],
    [
      // With a negative axis, and no configuration of its own.
      [{ name: "imagecodecs_delta" }, little, { name: "refkv.tiff_lzw" }],
      DataType.UINT16,
      [2, 4],
      GRAY_LZW,
      GRAY,
    ],
    [
      [
        delta(1),
        little,
        { name: "numcodecs.zlib", configuration: { level: 1 } },
      ],
      DataType.UINT16,
      [2, 4],
      // zlib's compress of the same differences
      [
        120, 156, 123, 193, 156, 194, 48, 141, 97, 209, 191, 255, 255, 153, 24,
        24, 129, 16, 0, 57, 130, 5, 136,
      ],
      GRAY,
    ],
    [
      [
        delta(1),
        { name: "bytes", configuration: { endian: "big" } },
        { name: "refkv.tiff_lzw" },
      ],
      DataType.UINT16,
      [2, 4],
      // `lzw_encode` of the big-endian differences
      [
        128, 0, 221, 0, 3, 32, 1, 44, 254, 81, 63, 223, 224, 0, 16, 0, 3, 14,
        128, 128,
      ],
      GRAY,
    ],
    [
      // Interleaved RGB: `transpose` first, then differences along x (axis 1
      // of `[y, x, s]`), each sample apart. The transposed layout is left as
      // stored, so that the decoded values are in the stored order.
      [
        { name: "transpose", configuration: { order: [1, 2, 0] } },
        delta(1),
        { name: "bytes" },
        { name: "refkv.tiff_lzw" },
      ],
      DataType.UINT8,
      [3, 2, 3],
      // `lzw_encode` of the differences of a 2 × 3 × 3 array
      [
        128, 2, 130, 129, 224, 8, 8, 7, 5, 1, 190, 128, 160, 144, 72, 4, 2, 254,
        126, 62, 96, 32,
      ],
      [10, 20, 30, 11, 22, 33, 12, 24, 36, 250, 5, 9, 3, 6, 10, 1, 2, 3],
    ],
  ] as const) {
    expect(
      await decode(codecs, dataType, [...chunkShape], [...encoded]),
    ).toEqual(decoded);
  }
});

test("rejects a float32 array", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_delta" }, { name: "bytes" }], {
      dataType: DataType.FLOAT32,
      chunkShape: [2, 4],
    }),
  ).toThrow("float32 arrays are not supported");
});

test("rejects a dist other than 1", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        { name: "imagecodecs_delta", configuration: { dist: 2 } },
        { name: "bytes" },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow("Only a dist of 1 is supported");
});

test("rejects an axis the array does not have", () => {
  for (const axis of [2, -3, 0.5]) {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "imagecodecs_delta", configuration: { axis } },
          { name: "bytes" },
        ],
        { dataType: DataType.UINT8, chunkShape: [2, 4] },
      ),
    ).toThrow("Expected integer in range [-2, 2)");
  }
});

test("rejects a chain that transposes after differencing", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        { name: "imagecodecs_delta" },
        { name: "transpose", configuration: { order: [1, 0] } },
        { name: "bytes" },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow("not supported before a transpose codec");
});

test("rejects a chain that shards after differencing", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        { name: "imagecodecs_delta" },
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [1, 4],
            codecs: [{ name: "bytes" }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
              { name: "crc32c" },
            ],
          },
        },
      ],
      { dataType: DataType.UINT8, chunkShape: [2, 4] },
    ),
  ).toThrow('"imagecodecs_delta" codec not supported before sharding codec');
});
