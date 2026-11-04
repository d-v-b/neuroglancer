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
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/floatpred/decode.js";
import "#src/datasource/zarr/codec/floatpred/resolve.js";
import "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function decodeChunk(
  codecs: unknown,
  info: CodecArrayInfo,
  encoded: Uint8Array<ArrayBuffer>,
  float64 = false,
) {
  return decodeArray(
    parseCodecChainSpec(codecs, info, float64),
    encoded,
    new AbortController().signal,
  );
}

// Written by imagecodecs 2026.8.16's `floatpred_encode`, which `floatpred_decode`
// reads back. The script also checked that big-endian values encode to the same
// bytes, which is why the codec has no `endian`. `expected` is little-endian.
const CASES = [
  {
    name: "float32, [h, w]",
    shape: [3, 5],
    axis: 1,
    bytesPerValue: 4,
    encoded:
      "xH4C/wGEuLnfPyO5BmVR2GHjeBlFf4CAf/OCtGTbZsmE5pu3w+wR+MSAgICAPKWyqp1+XJnORULjpqII",
    expected:
      "x3rIxCgzgEILOTlEg54YQ5zvV0SWETZFWdq4xEVebERWRNDETt+rQ2YcAMRJeKVE7xFXxJHfAUSZJJ7E",
  },
  {
    name: "float32, [1, 1, h, w], negative axis",
    shape: [1, 1, 4, 3],
    axis: -1,
    bytesPerValue: 4,
    encoded: "wH4By9T/UmZHeR76P4B/x3sJnh8eH3WePwCAhVT80RaragpwP/9/dYFRO6ndmTIe",
    expected:
      "VS8KwHOV3j5t3N0/gycFP/hGgL+WZIk+kGVEP5p7mD8KJpS/Xj8yP5Dosz6uxQS9",
  },
  {
    name: "float32, [h, w, s]",
    shape: [2, 4, 3],
    axis: 1,
    bytesPerValue: 4,
    encoded:
      "P8LBA38AgIEAAACBZkW2XUjIdOAKh1ZbOVQRZjlhDj6dI7j+FpFJr4h5u/AuS1ewwcLCAIAAgX8A/4H/BGfEKrURMGQVLs2G+GlS8f4hTPh4OsdVZ8V5aKMn0/wmknVE",
    expected:
      "ZrkoP5nZB8J7NvjBFR+FQiEST0H0l8DB0C35whFQL8IiNMrBG1CAwmgIhcLSMiVCo8VFwXr4qcLqg4XCC7ZvwR32XkIRpJbC3gKfQhnuwsE3HKvCcDzNQY61j0J7cTHB",
  },
  {
    name: "float32, [1, h, w, s], special values",
    shape: [1, 2, 2, 3],
    axis: 2,
    bytesPerValue: 4,
    encoded: "AIB/f3+BgQGAwICBQID/AAAWAADqAADCP0BAMrH9Dw8DyUmMt7c08vLMDg40ysrN",
    expected:
      "AAAAAAAAAIAAAIB/AADAfwAAgP/CFgEAAACAPwAAAEAAAEBAyvJJccrySfHNzMw9",
  },
  {
    name: "float64, [h, w]",
    shape: [3, 4],
    axis: 1,
    bytesPerValue: 8,
    encoded:
      "QYD/geLwsnSTmwr4eCsUaHjH4tdUcogu6b42l2cHGRVBgICAagcT6icDA84qVVwTxlJe8NjgeMCOpeG8RFfapEEAf4Ho9dYU2YU3Gh61EFAUbc1jwTvEAAGuptahfTB3",
    expected:
      "1+XUAOHMI0Heo0bHDGcTwffZzqkgccXADHD8gIhpOUGC/FbeVFYrQdmhNjCpWTLBs4KujgVcRUFXPm5+GCovwSdcXP7V4SlBpAqXa4pmHkHUsFs4mp30wEuGW5vqtwhB",
  },
  {
    name: "float64, [h, w, s]",
    shape: [2, 3, 2],
    axis: 1,
    bytesPerValue: 8,
    encoded:
      "vz8AgICAhasiCPgJGc7VAJ4DLGW4IHwNqxPP7v8gNTUuy++1lgcexKwb0BI/0yslvz8AAIAAgrz1/Tjoj2AYqj/Qtg/wrca2398ftLl1Go5OtBsMsu7Y9L0jF3nk3Bs5",
    expected:
      "xSt4dZb3xL8sO7RxMcnqPwRJpkROzOa///9/X1HJ8r8v9ZVDymrePyQaNH9ezPs/2CwRH4p9wb8AcMILyUD7P7wEXz56lba/3GR2v3bq+D/XwXr3QNTuPxWHgjQsuuA/",
  },
  {
    name: "float64, one row of one value",
    shape: [1, 1],
    axis: 1,
    bytesPerValue: 8,
    encoded: "P7kIAAAAAAA=",
    expected: "AAAAAAAA+D8=",
  },
];

test("decodes the streams imagecodecs writes", async () => {
  for (const { shape, axis, bytesPerValue, encoded, expected } of CASES) {
    const bytes = fromBase64(expected);
    const float64 = bytesPerValue === 8;
    const values = float64
      ? Float32Array.from(new Float64Array(bytes.buffer))
      : new Float32Array(bytes.buffer);
    const chain = parseCodecChainSpec(
      [{ name: "imagecodecs_floatpred", configuration: { axis, dist: 1 } }],
      { dataType: DataType.FLOAT32, chunkShape: shape },
      float64,
    );
    // The size LZW stops decoding at, which is that of the stored values.
    expect(chain.encodedSize[0]).toBe(bytes.length);
    const decoded = await decodeArray(
      chain,
      fromBase64(encoded),
      new AbortController().signal,
    );
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(decoded).toEqual(values);
  }
});

test("defaults to the last axis, and follows a transpose", async () => {
  const { encoded, expected, shape } = CASES[0];
  const values = new Float32Array(fromBase64(expected).buffer);
  const info = { dataType: DataType.FLOAT32, chunkShape: shape };
  expect(
    await decodeChunk(
      [{ name: "imagecodecs_floatpred" }],
      info,
      fromBase64(encoded),
    ),
  ).toEqual(values);
  // The codec sees the transposed shape, whose rows are this chunk's columns.
  expect(
    await decodeChunk(
      [
        { name: "transpose", configuration: { order: [1, 0] } },
        { name: "imagecodecs_floatpred", configuration: { axis: 1, dist: 1 } },
      ],
      { dataType: DataType.FLOAT32, chunkShape: [shape[1], shape[0]] },
      fromBase64(encoded),
    ),
  ).toEqual(values);
});

test("a float64 array's shard holds the stored float64 values", () => {
  const { shardingInfo } = parseCodecChainSpec(
    [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: [2, 4],
          codecs: [
            {
              name: "imagecodecs_floatpred",
              configuration: { axis: 1, dist: 1 },
            },
          ],
          index_codecs: [
            { name: "bytes", configuration: { endian: "little" } },
          ],
        },
      },
    ],
    { dataType: DataType.FLOAT32, chunkShape: [4, 4] },
    true,
  );
  expect(shardingInfo!.subChunkCodecs.encodedSize[0]).toBe(2 * 4 * 8);
});

test("rejects a float64 array whose shard's codecs do not decode it", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [2, 4],
            codecs: [{ name: "bytes", configuration: { endian: "little" } }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
            ],
          },
        },
      ],
      { dataType: DataType.FLOAT32, chunkShape: [4, 4] },
      true,
    ),
  ).toThrow(/float64 arrays are not supported with the "bytes" codec/);
});

test("rejects a dist other than 1", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_floatpred", configuration: { axis: 1, dist: 3 } }],
      { dataType: DataType.FLOAT32, chunkShape: [2, 2] },
    ),
  ).toThrow(/Only a dist of 1 is supported/);
});

test("rejects integer data types", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_floatpred", configuration: { axis: 1, dist: 1 } }],
      { dataType: DataType.UINT16, chunkShape: [2, 2] },
    ),
  ).toThrow(/supports the float32 and float64 data types, not uint16/);
});

test("rejects an axis that is not one of the last two", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_floatpred", configuration: { axis: 0, dist: 1 } }],
      { dataType: DataType.FLOAT32, chunkShape: [2, 3, 4] },
    ),
  ).toThrow(/axis 0 is not one of the last two/);
});

test("rejects an axis out of range", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_floatpred", configuration: { axis: 2, dist: 1 } }],
      { dataType: DataType.FLOAT32, chunkShape: [2, 2] },
    ),
  ).toThrow(/Expected integer in range/);
});

test("rejects a chunk of the wrong size", async () => {
  // A float32 chunk's bytes, read as those of a float64 array.
  await expect(
    decodeChunk(
      [{ name: "imagecodecs_floatpred", configuration: { axis: 1, dist: 1 } }],
      { dataType: DataType.FLOAT32, chunkShape: [2, 2] },
      new Uint8Array(16),
      true,
    ),
  ).rejects.toThrow(
    /chunk is 16 bytes, but a chunk of shape \[2, 2\] is 32 bytes/,
  );
});
