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
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import "#src/datasource/zarr/codec/gzip/decode.js";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

// A 3 × 4 little-endian uint16 chunk of 1000 * i + j.
const DECODED = Array.from({ length: 12 }, (_, k) => 1000 * (k >> 2) + (k & 3));

async function decode(encoded: number[] | Uint8Array, configuration: unknown) {
  const spec = parseCodecChainSpec(
    [
      { name: "bytes", configuration: { endian: "little" } },
      { name: "numcodecs.zlib", configuration },
    ],
    { dataType: DataType.UINT16, chunkShape: [4, 3] },
  );
  return Array.from(
    (await decodeArray(
      spec,
      Uint8Array.from(encoded),
      new AbortController().signal,
    )) as Uint16Array,
  );
}

test("decodes zlib streams as Python's zlib writes them", async () => {
  // `zlib.compress(struct.pack("<12H", *DECODED), level)`.
  for (const [level, encoded] of [
    [
      0,
      [
        120, 1, 1, 24, 0, 231, 255, 0, 0, 1, 0, 2, 0, 3, 0, 232, 3, 233, 3, 234,
        3, 235, 3, 208, 7, 209, 7, 210, 7, 211, 7, 65, 68, 7, 27,
      ],
    ],
    [
      1,
      [
        120, 1, 99, 96, 96, 100, 96, 98, 96, 102, 120, 193, 252, 146, 249, 21,
        243, 107, 230, 11, 236, 23, 217, 47, 177, 95, 102, 7, 0, 65, 68, 7, 27,
      ],
    ],
    [
      9,
      [
        120, 218, 99, 96, 96, 100, 96, 98, 96, 102, 120, 193, 252, 146, 249, 21,
        243, 107, 230, 11, 236, 23, 217, 47, 177, 95, 102, 7, 0, 65, 68, 7, 27,
      ],
    ],
  ] as const) {
    expect(await decode([...encoded], { level })).toEqual(DECODED);
  }
});

test("rejects a configuration without a level", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        { name: "bytes", configuration: { endian: "little" } },
        { name: "numcodecs.zlib", configuration: {} },
      ],
      { dataType: DataType.UINT16, chunkShape: [4, 3] },
    ),
  ).toThrow(/level/);
});

test("rejects a gzip stream", async () => {
  const gzip = gzipSync(new Uint8Array(new Uint16Array(DECODED).buffer));
  await expect(decode(gzip, { level: 1 })).rejects.toThrow(
    /Failed to decode deflate/,
  );
});
