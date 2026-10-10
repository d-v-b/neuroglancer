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
import { checkJpegXrChunk } from "#src/datasource/zarr/codec/jpegxr/decode.js";
import { decompressJpegXr } from "#src/sliceview/jpegxr/index.js";
import { DataType } from "#src/util/data_type.js";

declare const TEST_DATA_SERVER: string;

async function fixture(name: string) {
  const get = async (ext: string) => {
    const response = await fetch(
      `${TEST_DATA_SERVER}codec/jpegxr/${name}.${ext}`,
    );
    expect(response.ok).toBe(true);
    return new Uint8Array(await response.arrayBuffer());
  };
  const info = JSON.parse(new TextDecoder().decode(await get("json"))) as {
    shape: number[];
    dtype: string;
  };
  return { encoded: await get("jxr"), expected: await get("raw"), info };
}

test("decodes like imagecodecs (jxrlib)", async () => {
  // One per pixel format of CZI JpgXr subblocks; `bgr24` and `bgra32` are
  // stored as 24bppBGR and 32bppBGRA and decode to R, G, B (A).
  for (const name of [
    "gray8",
    "gray8_lossy",
    "gray16",
    "gray32float",
    "rgb24",
    "bgr24",
    "bgr24_lossy",
    "bgr48",
    "bgr96float",
    "bgra32",
  ]) {
    const { encoded, expected, info } = await fixture(name);
    const decoded = await decompressJpegXr(encoded);
    const [height, width, numComponents = 1] = info.shape;
    const bytesPerSample = { uint8: 1, uint16: 2, float32: 4 }[info.dtype];
    expect({ name, ...decoded, data: undefined }).toEqual({
      name,
      width,
      height,
      numComponents,
      bytesPerSample,
      isFloat: info.dtype === "float32",
      data: undefined,
    });
    expect(decoded.data).toEqual(expected);
  }
});

test("decoded images fill chunks of their data type", () => {
  for (const [dataType, chunkShape, decoded] of [
    [
      DataType.UINT16,
      [1, 1, 23, 37],
      {
        width: 37,
        height: 23,
        numComponents: 1,
        bytesPerSample: 2,
        isFloat: false,
      },
    ],
    [
      DataType.UINT8,
      [1, 23, 37, 3],
      {
        width: 37,
        height: 23,
        numComponents: 3,
        bytesPerSample: 1,
        isFloat: false,
      },
    ],
    [
      DataType.FLOAT32,
      [23, 37],
      {
        width: 37,
        height: 23,
        numComponents: 1,
        bytesPerSample: 4,
        isFloat: true,
      },
    ],
  ] as const) {
    checkJpegXrChunk(dataType, chunkShape, decoded);
  }
});

test("rejects a chunk the image does not fill", () => {
  expect(() =>
    checkJpegXrChunk(DataType.UINT8, [1, 37, 23], {
      width: 37,
      height: 23,
      numComponents: 1,
      bytesPerSample: 1,
      isFloat: false,
    }),
  ).toThrow(/^JPEG XR image of shape \[23, 37\] .* does not fill a chunk/);
});

test("rejects samples of another data type", () => {
  expect(() =>
    checkJpegXrChunk(DataType.UINT8, [23, 37], {
      width: 37,
      height: 23,
      numComponents: 1,
      bytesPerSample: 2,
      isFloat: false,
    }),
  ).toThrow(/16-bit integer samples does not match data type uint8/);
  expect(() =>
    checkJpegXrChunk(DataType.UINT32, [23, 37], {
      width: 37,
      height: 23,
      numComponents: 1,
      bytesPerSample: 4,
      isFloat: true,
    }),
  ).toThrow(/32-bit float samples does not match data type uint32/);
});

test("rejects a malformed file", async () => {
  const { encoded } = await fixture("gray8");
  await expect(decompressJpegXr(encoded.slice(0, 30))).rejects.toThrow(
    /^jpegxr: /,
  );
});
