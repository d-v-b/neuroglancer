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

import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import "#src/datasource/zarr/codec/bytes/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import "#src/datasource/zarr/codec/gzip/decode.js";
import "#src/datasource/zarr/codec/n5_default/decode.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

// An N5 block: the header for `shape` (in the array's dimension order), then
// the uint16 element (i, j) = 10 * i + j, big-endian, first dimension
// fastest, as Java N5 writes it.
function n5Block(shape: [number, number], compress = false) {
  const body = new Uint8Array(2 * shape[0] * shape[1]);
  const dv = new DataView(body.buffer);
  let k = 0;
  for (let j = 0; j < shape[1]; ++j) {
    for (let i = 0; i < shape[0]; ++i) dv.setUint16(2 * k++, 10 * i + j);
  }
  return withHeader([0, 2, ...shape], compress ? gzipSync(body) : body);
}

function withHeader(header: number[], body: Uint8Array) {
  const out = new Uint8Array(4 + 4 * (header.length - 2) + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, header[0]);
  dv.setUint16(2, header[1]);
  header.slice(2).forEach((n, i) => dv.setUint32(4 + 4 * i, n));
  out.set(body, out.length - body.length);
  return out;
}

const innerCodecs = (compress: boolean) => [
  { name: "transpose", configuration: { order: [1, 0] } },
  { name: "bytes", configuration: { endian: "big" } },
  ...(compress ? [{ name: "gzip", configuration: { level: 6 } }] : []),
];

async function decode(
  block: Uint8Array<ArrayBuffer>,
  chunkShape: [number, number],
  compress = false,
) {
  const spec = parseCodecChainSpec(
    [{ name: "n5_default", configuration: { codecs: innerCodecs(compress) } }],
    { dataType: DataType.UINT16, chunkShape },
  );
  return Array.from(
    (await decodeArray(
      spec,
      block,
      new AbortController().signal,
    )) as Uint16Array,
  );
}

// The chunk's elements, as Neuroglancer lays them out for this codec (first
// dimension fastest): (i, j) = 10 * i + j where the block has it, else 0.
function expected(chunk: [number, number], block: [number, number]) {
  const out: number[] = [];
  for (let j = 0; j < chunk[1]; ++j) {
    for (let i = 0; i < chunk[0]; ++i) {
      out.push(i < block[0] && j < block[1] ? 10 * i + j : 0);
    }
  }
  return out;
}

test("decodes N5 blocks of the chunk's size, smaller and larger", async () => {
  for (const compress of [false, true]) {
    for (const [chunk, block] of [
      [
        [2, 3],
        [2, 3],
      ],
      [
        [3, 4],
        [2, 3],
      ],
      [
        [2, 3],
        [3, 4],
      ],
      [
        [3, 4],
        [1, 4],
      ],
      [
        [3, 4],
        [0, 4],
      ],
    ] as [number, number][][]) {
      expect(
        await decode(
          n5Block(block as [number, number], compress),
          chunk as [number, number],
          compress,
        ),
      ).toEqual(expected(chunk as [number, number], block as [number, number]));
    }
  }
  // The decoded layout is the inner codecs': first dimension fastest.
  const spec = parseCodecChainSpec(
    [{ name: "n5_default", configuration: { codecs: innerCodecs(false) } }],
    { dataType: DataType.UINT16, chunkShape: [2, 3] },
  );
  expect(spec.layoutInfo[0].physicalToLogicalDimension).toEqual([1, 0]);
});

test("rejects a block whose mode is not default", async () => {
  await expect(
    decode(withHeader([1, 2, 2, 3], new Uint8Array(12)), [2, 3]),
  ).rejects.toThrow(/mode 1 is not default/);
});

test("rejects a block with another number of dimensions", async () => {
  await expect(
    decode(withHeader([0, 3, 2, 3, 1], new Uint8Array(12)), [2, 3]),
  ).rejects.toThrow(/3 dimensions, the array 2/);
});

test("rejects a block shorter than its header", async () => {
  for (const block of [
    new Uint8Array(3),
    new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2]),
  ]) {
    await expect(decode(block, [2, 3])).rejects.toThrow(
      /shorter than its header/,
    );
  }
});

test("rejects a missing codecs configuration", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "n5_default", configuration: {} }], {
      dataType: DataType.UINT16,
      chunkShape: [2, 3],
    }),
  ).toThrow();
});
