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
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { unshuffle } from "#src/datasource/zarr/codec/numcodecs_shuffle/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

test("unshuffles like numcodecs", () => {
  // `numcodecs.Shuffle(elementsize).encode(bytes(range(10, 10 + n)))`.
  for (const [elementSize, encoded] of [
    [2, [10, 12, 14, 16, 18, 11, 13, 15, 17, 19]],
    [4, [10, 14, 18, 11, 15, 19, 12, 16, 20, 13, 17, 21]],
    [3, [10, 13, 16, 11, 14, 17, 12, 15, 18]],
    [2, []],
  ] as const) {
    expect(
      Array.from(unshuffle(Uint8Array.from(encoded), elementSize)),
    ).toEqual(Array.from(encoded, (_, i) => 10 + i));
  }
});

test("resolves in a CZI hi-lo chain", () => {
  // The codecs of a Zstd1 hi-lo subblock: bytes, numcodecs.shuffle, zstd.
  const spec = parseCodecChainSpec(
    [
      { name: "bytes", configuration: { endian: "little" } },
      { name: "numcodecs.shuffle", configuration: { elementsize: 2 } },
      { name: "zstd", configuration: { level: 0, checksum: false } },
    ],
    { dataType: DataType.UINT16, chunkShape: [8, 12] },
  );
  expect(spec[CodecKind.bytesToBytes]).toEqual([
    {
      kind: CodecKind.bytesToBytes,
      name: "numcodecs.shuffle",
      configuration: { elementSize: 2 },
    },
    { kind: CodecKind.bytesToBytes, name: "zstd", configuration: {} },
  ]);
});

test("rejects a length that is not a whole number of elements", () => {
  expect(() => unshuffle(new Uint8Array(5), 2)).toThrow(
    /5 bytes are not a whole number of 2-byte elements/,
  );
});

test("rejects a missing or non-positive elementsize", () => {
  for (const configuration of [{}, { elementsize: 0 }, { elementsize: 1.5 }]) {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "bytes", configuration: { endian: "little" } },
          { name: "numcodecs.shuffle", configuration },
        ],
        { dataType: DataType.UINT16, chunkShape: [8, 12] },
      ),
    ).toThrow(/elementsize/);
  }
});
