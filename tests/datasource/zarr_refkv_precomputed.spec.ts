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

// What the codec's configuration must be; tests/codec/refkv_precomputed.browser_test.ts
// reads chunks.

import { expect, test } from "vitest";
import "#src/datasource/zarr/codec/resolvers.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";

const SHARDING = {
  preshift_bits: 11,
  minishard_bits: 2,
  minishard_index_encoding: "gzip",
  data_encoding: "raw",
};

function parse(
  configuration: Record<string, unknown>,
  {
    dataType = "uint8",
    shape = [100, 100, 100],
    chunkShape = [16, 128, 128],
  }: { dataType?: string; shape?: number[]; chunkShape?: number[] } = {},
) {
  return parseV3Metadata(
    {
      zarr_format: 3,
      node_type: "array",
      shape,
      data_type: dataType,
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: chunkShape },
      },
      chunk_key_encoding: { name: "default" },
      fill_value: 0,
      codecs: [{ name: "refkv.precomputed", configuration }],
    },
    "array",
  ) as ArrayMetadata;
}

const VOLUME = {
  encoding: "raw",
  size: [100, 100, 100],
  chunk_size: [128, 128, 16],
};

test("reads a chunk of the volume, a shard's box a sharded array's chunk", () => {
  for (const [configuration, options, readChunkShape, grid] of [
    [VOLUME, {}, [16, 128, 128], undefined],
    [
      VOLUME,
      { shape: [3, 100, 100, 100], chunkShape: [3, 16, 128, 128] },
      [3, 16, 128, 128],
      undefined,
    ],
    // BANC's finest scale
    [
      { ...VOLUME, encoding: "jpeg", sharding: SHARDING },
      { chunkShape: [256, 2048, 4096] },
      [16, 128, 128],
      [16, 16, 32],
    ],
    [
      { ...VOLUME, sharding: SHARDING },
      { shape: [3, 100, 100, 100], chunkShape: [3, 256, 2048, 4096] },
      [3, 16, 128, 128],
      [1, 16, 16, 32],
    ],
    [
      {
        ...VOLUME,
        encoding: "compressed_segmentation",
        compressed_segmentation_block_size: [8, 8, 8],
      },
      { dataType: "uint64" },
      [16, 128, 128],
      undefined,
    ],
    [
      { ...VOLUME, encoding: "png" },
      { dataType: "uint16" },
      [16, 128, 128],
      undefined,
    ],
    [
      { ...VOLUME, encoding: "compresso" },
      { dataType: "uint32" },
      [16, 128, 128],
      undefined,
    ],
    [
      { ...VOLUME, encoding: "crackle", sharding: SHARDING },
      { dataType: "uint64", chunkShape: [256, 2048, 4096] },
      [16, 128, 128],
      [16, 16, 32],
    ],
    [{ ...VOLUME, encoding: "jxl" }, {}, [16, 128, 128], undefined],
  ] as const) {
    const { codecs } = parse(configuration as any, options as any);
    expect(codecs.layoutInfo[0].readChunkShape).toEqual(readChunkShape);
    expect(codecs.shardingInfo?.subChunkGridShape).toEqual(grid);
  }
});

test("rejects an encoding with no decoder", () => {
  for (const encoding of ["fpzip", "zfpc", "kempressed"]) {
    expect(() => parse({ ...VOLUME, encoding })).toThrow(
      `the encoding "${encoding}" has no decoder`,
    );
  }
});

test("rejects an unknown configuration member", () => {
  expect(() => parse({ ...VOLUME, hash: "identity" })).toThrow(
    'unknown configuration member "hash"',
  );
});

test("rejects an unknown sharding member", () => {
  expect(() =>
    parse(
      { ...VOLUME, sharding: { ...SHARDING, hash: "identity" } },
      { chunkShape: [256, 2048, 4096] },
    ),
  ).toThrow('unknown sharding member "hash"');
});

test("rejects a size of other than 3 positive integers", () => {
  expect(() => parse({ ...VOLUME, size: [1, 2] })).toThrow(
    "size is not 3 integers",
  );
  expect(() => parse({ ...VOLUME, size: [1, 2, 0] })).toThrow("size has 0");
});

test("rejects an array of another rank", () => {
  expect(() =>
    parse(VOLUME, { shape: [100, 100], chunkShape: [128, 128] }),
  ).toThrow("the array has 2 dimensions");
});

test("rejects jpeg of another data type", () => {
  expect(() =>
    parse({ ...VOLUME, encoding: "jpeg" }, { dataType: "uint16" }),
  ).toThrow("jpeg holds uint8 in 1 or 3 channels, not uint16 in 1");
});

test("rejects jpeg of another number of channels", () => {
  expect(() =>
    parse(
      { ...VOLUME, encoding: "jpeg" },
      { shape: [2, 100, 100, 100], chunkShape: [2, 16, 128, 128] },
    ),
  ).toThrow("jpeg holds uint8 in 1 or 3 channels, not uint8 in 2");
});

test("rejects png of another data type", () => {
  expect(() =>
    parse({ ...VOLUME, encoding: "png" }, { dataType: "float32" }),
  ).toThrow("png holds uint8 or uint16 in at most 4 channels, not float32");
});

test("rejects compresso of another data type", () => {
  expect(() =>
    parse({ ...VOLUME, encoding: "compresso" }, { dataType: "int32" }),
  ).toThrow("compresso holds uint8 to uint64 in 1 channel, not int32 in 1");
});

test("rejects crackle of another number of channels", () => {
  expect(() =>
    parse(
      { ...VOLUME, encoding: "crackle" },
      { shape: [2, 100, 100, 100], chunkShape: [2, 16, 128, 128] },
    ),
  ).toThrow("crackle holds uint8 to uint64 in 1 channel, not uint8 in 2");
});

test("rejects jxl of another data type", () => {
  expect(() =>
    parse({ ...VOLUME, encoding: "jxl" }, { dataType: "uint16" }),
  ).toThrow("jxl holds uint8 in 1 channel, not uint16 in 1");
});

test("rejects jxl of another number of channels", () => {
  expect(() =>
    parse(
      { ...VOLUME, encoding: "jxl" },
      { shape: [3, 100, 100, 100], chunkShape: [3, 16, 128, 128] },
    ),
  ).toThrow("jxl holds uint8 in 1 channel, not uint8 in 3");
});

test("rejects compressed_segmentation of another data type", () => {
  expect(() =>
    parse({
      ...VOLUME,
      encoding: "compressed_segmentation",
      compressed_segmentation_block_size: [8, 8, 8],
    }),
  ).toThrow("compressed_segmentation holds uint32 or uint64, not uint8");
});

test("rejects compressed_segmentation with no block size", () => {
  expect(() =>
    parse(
      { ...VOLUME, encoding: "compressed_segmentation" },
      { dataType: "uint32" },
    ),
  ).toThrow("needs compressed_segmentation_block_size");
});

test("rejects an array chunk that holds part of a chunk", () => {
  expect(() => parse(VOLUME, { chunkShape: [16, 100, 128] })).toThrow(
    "does not hold whole chunks",
  );
});

test("rejects an unsharded array chunk of several chunks", () => {
  expect(() => parse(VOLUME, { chunkShape: [32, 128, 128] })).toThrow(
    "is not one chunk",
  );
});

test("rejects a shard's box of other than a power of 2", () => {
  expect(() =>
    parse({ ...VOLUME, sharding: SHARDING }, { chunkShape: [48, 128, 128] }),
  ).toThrow("not a power of 2");
});

test("rejects an unknown shard encoding", () => {
  expect(() =>
    parse(
      {
        ...VOLUME,
        sharding: { ...SHARDING, data_encoding: "zstd" },
      },
      { chunkShape: [256, 2048, 4096] },
    ),
  ).toThrow('Invalid enum value: "zstd"');
});

test("rejects shard bits out of range", () => {
  expect(() =>
    parse(
      {
        ...VOLUME,
        sharding: { ...SHARDING, minishard_bits: 33 },
      },
      { chunkShape: [256, 2048, 4096] },
    ),
  ).toThrow("minishard_bits 33 is not 0 to 32");
});

test("rejects a data type the viewer has no type for", () => {
  expect(() => parse(VOLUME, { dataType: "float64" })).toThrow(
    'float64 arrays are not supported with the "refkv.precomputed" codec',
  );
});
