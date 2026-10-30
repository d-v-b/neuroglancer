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
import "#src/datasource/zarr/codec/gzip/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { skip } from "#src/datasource/zarr/codec/refkv_skip/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

test("drops the bytes before a chunk's own", () => {
  for (const [length, encoded, decoded] of [
    [0, [1, 2, 3], [1, 2, 3]],
    [2, [9, 9, 1, 2, 3], [1, 2, 3]],
    [3, [1, 2, 3], []],
  ] as const) {
    expect(Array.from(skip(Uint8Array.from(encoded), length))).toEqual(decoded);
  }
});

test("resolves in a deflated .npz member's chain", () => {
  // The codecs refkv gives a deflated member: bytes, refkv.skip, gzip.
  const spec = parseCodecChainSpec(
    [
      { name: "bytes", configuration: { endian: "little" } },
      { name: "refkv.skip", configuration: { length: 128 } },
      { name: "gzip", configuration: { level: 6 } },
    ],
    { dataType: DataType.FLOAT32, chunkShape: [4, 5] },
  );
  expect(spec[CodecKind.bytesToBytes]).toEqual([
    {
      kind: CodecKind.bytesToBytes,
      name: "refkv.skip",
      configuration: { length: 128 },
    },
    { kind: CodecKind.bytesToBytes, name: "gzip", configuration: { level: 6 } },
  ]);
});

test("decodes a gzip stream of a header and then the values", async () => {
  const values = Float32Array.from([1.5, -2, 3.25, 4]);
  const header = new Uint8Array(128).fill(0x20);
  const stream = new Uint8Array(128 + values.byteLength);
  stream.set(header);
  stream.set(new Uint8Array(values.buffer), 128);
  const spec = parseCodecChainSpec(
    [
      { name: "bytes", configuration: { endian: "little" } },
      { name: "refkv.skip", configuration: { length: 128 } },
      { name: "gzip", configuration: { level: 6 } },
    ],
    { dataType: DataType.FLOAT32, chunkShape: [4] },
  );
  const decoded = await decodeArray(
    spec,
    new Uint8Array(gzipSync(stream)),
    new AbortController().signal,
  );
  expect(Array.from(decoded as Float32Array)).toEqual(Array.from(values));
});

test("rejects a chunk shorter than the length", () => {
  expect(() => skip(new Uint8Array(3), 4)).toThrow(
    /a chunk of 3 bytes, fewer than the 4 it skips/,
  );
});

test("rejects a missing or negative length", () => {
  for (const configuration of [{}, { length: -1 }, { length: 1.5 }]) {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "bytes", configuration: { endian: "little" } },
          { name: "refkv.skip", configuration },
        ],
        { dataType: DataType.FLOAT32, chunkShape: [4, 5] },
      ),
    ).toThrow(/length/);
  }
});
