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
import "#src/datasource/zarr/codec/resolvers.js";
import {
  copyBox,
  getCoveringChunks,
  RectilinearDimension,
} from "#src/datasource/zarr/metadata/chunk_grid.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";

function arrayJson(
  shape: number[],
  chunkGrid: unknown,
  codecs: unknown[] = [{ name: "bytes", configuration: { endian: "little" } }],
) {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "uint16",
    chunk_grid: chunkGrid,
    chunk_key_encoding: { name: "default" },
    fill_value: 0,
    codecs,
  };
}

function rectilinear(chunkShapes: unknown, kind: unknown = "inline") {
  return {
    name: "rectilinear",
    configuration: { kind, chunk_shapes: chunkShapes },
  };
}

test("parses chunk lengths and addresses chunks by cumulative length", () => {
  // A clipped CZI pyramid level, as vzip writes it (spec/virtualize/czi.md
  // §4.3): 10 rows of 1024, 15 columns of 1024 and a last one of 959.
  const czi = parseV3Metadata(
    arrayJson([10240, 16319], rectilinear([1024, [[1024, 15], 959]]), [
      { name: "imagecodecs_jpegxr" },
    ]),
    "array",
  ) as ArrayMetadata;
  expect(czi.chunkShape).toEqual([1024, 1024]);
  expect(czi.chunkGrid!.runs).toEqual([
    [[1024, 10]],
    [
      [1024, 15],
      [959, 1],
    ],
  ]);
  expect(czi.codecs.layoutInfo[0].readChunkShape).toEqual([1024, 1024]);

  // The example of the rectilinear chunk grid specification: chunks wholly
  // beyond the extent are dropped.
  const example = parseV3Metadata(
    arrayJson(
      [6, 6, 6, 6, 6],
      rectilinear([4, [1, 2, 3], [[4, 2]], [[1, 3], 3], [4, 4, 4]]),
    ),
    "array",
  ) as ArrayMetadata;
  expect(example.chunkShape).toEqual([4, 3, 4, 3, 4]);
  expect(example.chunkGrid!.runs).toEqual([
    [[4, 2]],
    [
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    [[4, 2]],
    [
      [1, 3],
      [3, 1],
    ],
    [[4, 2]],
  ]);

  // A regular grid has no chunkGrid.
  const regular = parseV3Metadata(
    arrayJson([10, 10], {
      name: "regular",
      configuration: { chunk_shape: [4, 4] },
    }),
    "array",
  ) as ArrayMetadata;
  expect(regular.chunkShape).toEqual([4, 4]);
  expect(regular.chunkGrid).toBeUndefined();

  // Chunks 1, 1, 1, 3 (starts 0, 1, 2, 3) and 4, 4 (starts 6, 10).
  const dimension = new RectilinearDimension([
    [1, 3],
    [3, 1],
    [4, 2],
  ]);
  expect(
    [0, 1, 2, 3, 5, 6, 9, 10, 13].map((p) => dimension.findChunk(p)),
  ).toEqual([
    { index: 0, start: 0, length: 1 },
    { index: 1, start: 1, length: 1 },
    { index: 2, start: 2, length: 1 },
    { index: 3, start: 3, length: 3 },
    { index: 3, start: 3, length: 3 },
    { index: 4, start: 6, length: 4 },
    { index: 4, start: 6, length: 4 },
    { index: 5, start: 10, length: 4 },
    { index: 5, start: 10, length: 4 },
  ]);
  // Neuroglancer chunks of 4 (the largest length): [0, 4) overlaps four
  // zarr chunks, [4, 8) two, [12, 14) one, unaligned.
  expect(getCoveringChunks(dimension, 0, 4).map((c) => c.index)).toEqual([
    0, 1, 2, 3,
  ]);
  expect(getCoveringChunks(dimension, 4, 8).map((c) => c.index)).toEqual([
    3, 4,
  ]);
  expect(getCoveringChunks(dimension, 12, 14)).toEqual([
    { index: 5, start: 10, length: 4 },
  ]);
  // The clipped CZI column: the last Neuroglancer chunk is the 959-wide one.
  const clipped = new RectilinearDimension(czi.chunkGrid!.runs[1]);
  expect(getCoveringChunks(clipped, 15 * 1024, 16319)).toEqual([
    { index: 15, start: 15360, length: 959 },
  ]);

  // Copying a 2x2 box from a 3x3 chunk (Fortran order) into a 4x2 one.
  const src = Uint16Array.from({ length: 9 }, (_, i) => i);
  const dest = new Uint16Array(8);
  copyBox(dest, [4, 2], [2, 0], src, [3, 3], [1, 1], [2, 2]);
  expect(Array.from(dest)).toEqual([0, 0, 4, 5, 0, 0, 7, 8]);
});

test("rejects chunk lengths that do not cover the extent", () => {
  expect(() =>
    parseV3Metadata(arrayJson([10, 6], rectilinear([4, [2, 3]])), "array"),
  ).toThrow(/Dimension 1: Chunk lengths sum to 5, less than the extent 6/);
});

test("rejects non-positive chunk lengths and malformed runs", () => {
  for (const lengths of [0, [2, 0, 4], [[2, 0]], [[2, 3, 1]], "4"]) {
    expect(() =>
      parseV3Metadata(arrayJson([10, 6], rectilinear([4, lengths])), "array"),
    ).toThrow(/Dimension 1: Expected/);
  }
});

test("rejects chunk_shapes of the wrong length", () => {
  expect(() =>
    parseV3Metadata(arrayJson([10, 6], rectilinear([4])), "array"),
  ).toThrow(/Expected array of length 2/);
});

test("rejects a kind other than inline", () => {
  expect(() =>
    parseV3Metadata(arrayJson([10, 6], rectilinear([4, 4], "file")), "array"),
  ).toThrow(/"kind"/);
});

test("rejects an unknown chunk grid", () => {
  expect(() =>
    parseV3Metadata(
      arrayJson([10, 6], { name: "irregular", configuration: {} }),
      "array",
    ),
  ).toThrow(/Expected "regular" or "rectilinear"/);
});

test("rejects sharding with a rectilinear chunk grid", () => {
  expect(() =>
    parseV3Metadata(
      arrayJson([10, 6], rectilinear([4, [2, 4]]), [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [2, 2],
            codecs: [{ name: "bytes", configuration: { endian: "little" } }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
            ],
          },
        },
      ]),
      "array",
    ),
  ).toThrow(/sharding_indexed is not supported with a rectilinear/);
});
