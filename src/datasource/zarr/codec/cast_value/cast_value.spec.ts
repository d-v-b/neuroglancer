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

import { describe, expect, it } from "vitest";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/cast_value/resolve.js";
import "#src/datasource/zarr/codec/cast_value/decode.js";
import "#src/datasource/zarr/codec/scale_offset/resolve.js";
import "#src/datasource/zarr/codec/scale_offset/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

// Codec chain of the reflectances of EOPF Sentinel-2 products: float32 reflectances stored as
// uint16 digital numbers, with NaN stored as 0.
const EOPF_CODECS = [
  { name: "scale_offset", configuration: { offset: -0.1, scale: 10000 } },
  {
    name: "cast_value",
    configuration: {
      data_type: "uint16",
      scalar_map: { encode: [["NaN", 0]], decode: [[0, "NaN"]] },
    },
  },
  { name: "bytes", configuration: { endian: "little" } },
];

describe("scale_offset and cast_value codecs", () => {
  it("decode stored integers to scaled values", async () => {
    const codecs = parseCodecChainSpec(EOPF_CODECS, {
      dataType: DataType.FLOAT32,
      chunkShape: [4],
    });
    expect(codecs.arrayInfo.map((info) => info.dataType)).toEqual([
      DataType.FLOAT32,
      DataType.FLOAT32,
      DataType.UINT16,
    ]);
    const encoded = new Uint8Array(Uint16Array.of(0, 1000, 3500, 11000).buffer);
    const decoded = (await decodeArray(
      codecs,
      encoded,
      new AbortController().signal,
    )) as Float32Array;
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(decoded[0]).toBeNaN();
    expect(Array.from(decoded.subarray(1)).map((x) => +x.toFixed(6))).toEqual([
      0, 0.25, 1,
    ]);
  });

  it("rejects a zero scale", () => {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "scale_offset", configuration: { scale: 0 } },
          { name: "bytes", configuration: { endian: "little" } },
        ],
        { dataType: DataType.FLOAT32, chunkShape: [4] },
      ),
    ).toThrow(/scale must be nonzero/);
  });

  it("rejects scale_offset for integer arrays", () => {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "scale_offset", configuration: { scale: 2 } },
          { name: "bytes", configuration: { endian: "little" } },
        ],
        { dataType: DataType.UINT16, chunkShape: [4] },
      ),
    ).toThrow(/only supported for float32/);
  });

  it("rejects unsupported cast data types", () => {
    expect(() =>
      parseCodecChainSpec(
        [
          { name: "cast_value", configuration: { data_type: "uint64" } },
          { name: "bytes", configuration: { endian: "little" } },
        ],
        { dataType: DataType.FLOAT32, chunkShape: [4] },
      ),
    ).toThrow(/does not support data type uint64/);
  });
});
