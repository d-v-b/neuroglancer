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
import type { ChunkExtent } from "#src/datasource/zarr/metadata/chunk_grid.js";
import {
  assembleChunk,
  regularDimension,
  spanChannelDimensions,
} from "#src/datasource/zarr/metadata/chunk_grid.js";

// A planar image (Fortran order: x, y, c) of shape 4 x 3 x 3, in zarr chunks
// of 2 x 3 x 2 (as vzip writes one channel per chunk, but with two here to
// show a chunk overflowing the channel extent). Voxel (x, y, c) holds
// x + 10 y + 100 c.
const shape = [4, 3, 3];
const chunkShape = [2, 3, 2];
const value = (x: number, y: number, c: number) => x + 10 * y + 100 * c;

// The zarr chunk with these extents, decoded (whole, as zarr stores edge
// chunks); `missing` lists chunk indices (joined by ",") that are absent.
function reader(missing: string[] = []) {
  const reads: string[] = [];
  const read = async (extents: ChunkExtent[]) => {
    const key = extents.map((e) => e.index).join();
    reads.push(key);
    if (missing.includes(key)) return undefined;
    const [ex, ey, ec] = extents;
    const data = new Uint16Array(ex.length * ey.length * ec.length);
    let k = 0;
    for (let c = 0; c < ec.length; ++c) {
      for (let y = 0; y < ey.length; ++y) {
        for (let x = 0; x < ex.length; ++x) {
          data[k++] = value(ex.start + x, ey.start + y, ec.start + c);
        }
      }
    }
    return data as Uint16Array<ArrayBuffer>;
  };
  return { read, reads };
}

const makeOutput = (n: number) => new Uint16Array(n).fill(7);

test("spans channel dimensions and assembles their zarr chunks", async () => {
  // Only the channel dimension widens, to the data's extent; one already
  // spanned stays.
  const chunk = Uint32Array.from(chunkShape);
  spanChannelDimensions(chunk, shape, [2]);
  expect(Array.from(chunk)).toEqual([2, 3, 3]);
  const whole = Uint32Array.of(4, 3, 8);
  spanChannelDimensions(whole, shape, [2]);
  expect(Array.from(whole)).toEqual([4, 3, 8]);
  spanChannelDimensions(whole, shape, []);
  expect(Array.from(whole)).toEqual([4, 3, 8]);

  const dimensions = shape.map((n, i) => regularDimension(chunkShape[i], n));

  // The Neuroglancer chunk at x in [2, 4) holds every channel: two zarr
  // chunks along c, the second overflowing the extent (only c = 2 copied).
  const { read, reads } = reader();
  const out = await assembleChunk(
    [2, 0, 0],
    [4, 3, 3],
    dimensions,
    read,
    makeOutput,
  );
  expect(reads).toEqual(["1,0,0", "1,0,1"]);
  expect(Array.from(out!.size)).toEqual([2, 3, 3]);
  const expected: number[] = [];
  for (let c = 0; c < 3; ++c) {
    for (let y = 0; y < 3; ++y) {
      for (let x = 2; x < 4; ++x) expected.push(value(x, y, c));
    }
  }
  expect(Array.from(out!.data)).toEqual(expected);

  // A missing zarr chunk (channels 2 and 3) leaves the fill value.
  const sparse = reader(["0,0,1"]);
  const filled = await assembleChunk(
    [0, 0, 0],
    [2, 3, 3],
    dimensions,
    sparse.read,
    makeOutput,
  );
  expect(Array.from(filled!.data)).toEqual([
    ...[0, 1, 10, 11, 20, 21],
    ...[100, 101, 110, 111, 120, 121],
    ...new Array(6).fill(7),
  ]);

  // A box that is one aligned zarr chunk is returned as decoded, at the
  // chunk's own size; missing, it gives nothing.
  const one = reader(["1,0,0"]);
  const single = await assembleChunk(
    [0, 0, 0],
    [2, 3, 2],
    dimensions,
    one.read,
    makeOutput,
  );
  expect(Array.from(single!.size)).toEqual([2, 3, 2]);
  expect(single!.data[1 + 2 * 3]).toBe(value(1, 0, 1));
  expect(
    await assembleChunk([2, 0, 0], [4, 3, 2], dimensions, one.read, makeOutput),
  ).toBeUndefined();

  // An empty box reads nothing.
  const none = reader();
  expect(
    await assembleChunk(
      [4, 0, 0],
      [4, 3, 3],
      dimensions,
      none.read,
      makeOutput,
    ),
  ).toBeUndefined();
  expect(none.reads).toEqual([]);
});
