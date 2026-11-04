/**
 * @license
 * Copyright 2023 Google Inc.
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

import { describe, expect, test } from "vitest";
import "#src/datasource/zarr/codec/dicomrle/decode.js";
import "#src/datasource/zarr/codec/jpegls/decode.js";
import "#src/datasource/zarr/codec/zarr_packbits/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";
import { DataType } from "#src/util/data_type.js";

/**
 * The arrays refkv writes for DICOM's 1-bit and RLE images and MRC's 4-bit ones
 * (spec/zarrify/dicom.md and spec/zarrify/mrc.md in d-v-b/refkv), through the
 * metadata parser and the codec chain.
 */
function metadata(
  dataType: string,
  shape: number[],
  codecs: unknown[],
  fill: unknown = 0,
) {
  return parseV3Metadata(
    {
      zarr_format: 3,
      node_type: "array",
      shape,
      data_type: dataType,
      chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      fill_value: fill,
      codecs,
      dimension_names: shape.map((_, i) => `d${i}`),
      attributes: {},
    },
    "array",
  ) as ArrayMetadata;
}

async function decoded(meta: ReturnType<typeof metadata>, encoded: number[]) {
  return Array.from(
    (await decodeArray(
      meta.codecs,
      Uint8Array.from(encoded),
      new AbortController().signal,
    )) as Uint8Array,
  );
}

describe("refkv's packed and RLE arrays", () => {
  test("a bool array of packbits is shown as uint8, 0 and 1", async () => {
    const meta = metadata(
      "bool",
      [2, 4],
      [{ name: "packbits", configuration: { padding_encoding: "none" } }],
      false,
    );
    expect(meta.dataType).toBe(DataType.UINT8);
    expect(meta.fillValue).toBe(0);
    expect(await decoded(meta, [0b10100101])).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });

  test("a uint8 array of packbits with last_bit 3 is low nibble first", async () => {
    const meta = metadata(
      "uint8",
      [2, 2],
      [
        {
          name: "packbits",
          configuration: { padding_encoding: "none", last_bit: 3 },
        },
      ],
    );
    expect(await decoded(meta, [0x21, 0xf3])).toEqual([1, 2, 3, 15]);
  });

  test("an RLE frame's samples are planar, in a chunk whose first axis is them", async () => {
    const meta = metadata(
      "uint8",
      [3, 1, 2],
      [
        {
          name: "imagecodecs_dicomrle",
          configuration: { dtype: "|u1" },
        },
      ],
    );
    const header = new Uint32Array(16);
    header.set([3, 64, 67, 70]);
    expect(
      await decoded(meta, [
        ...new Uint8Array(header.buffer),
        1,
        1,
        2,
        1,
        3,
        4,
        1,
        5,
        6,
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
