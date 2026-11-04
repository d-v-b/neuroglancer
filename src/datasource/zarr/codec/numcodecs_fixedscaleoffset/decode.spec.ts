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
import { unscale } from "#src/datasource/zarr/codec/numcodecs_fixedscaleoffset/decode.js";
import { parseStoredType } from "#src/datasource/zarr/codec/numcodecs_fixedscaleoffset/resolve.js";
import { DataType } from "#src/util/data_type.js";

test("gives stored / scale + offset in the array's data type", () => {
  for (const [stored, dataType, configuration, want] of [
    [Int16Array.of(-4, 0, 6), DataType.FLOAT32, { scale: 4, offset: 1 }, [0, 1, 2.5]],
    [Uint8Array.of(10, 25), DataType.UINT16, { scale: 10, offset: 3 }, [4, 5]],
    [Uint8Array.of(7), DataType.INT32, { scale: 2, offset: -10 }, [-6]],
  ] as const) {
    expect(
      Array.from(
        unscale(stored, dataType, configuration) as unknown as ArrayLike<number>,
      ),
    ).toEqual(want);
  }
});

test("reads a stored type by its kind and size, in either byte order", () => {
  for (const [text, dataType] of [
    ["<i2", DataType.INT16],
    [">i2", DataType.INT16],
    ["|u1", DataType.UINT8],
    ["<f4", DataType.FLOAT32],
  ] as const) {
    expect(parseStoredType(text)).toBe(dataType);
  }
});

test("rejects a stored type Neuroglancer has no data type for", () => {
  expect(() => parseStoredType("<i8")).toThrow(/Unsupported astype/);
});
