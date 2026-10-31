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
import "#src/datasource/zarr/codec/resolvers.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";

// A float64 array is shown as float32 only when its array -> bytes codec
// decodes it so (refkv.grib; tests/kvstore/refkv.spec.ts decodes one).
test("rejects a float64 array of a codec that decodes float64 values", () => {
  expect(() =>
    parseV3Metadata(
      {
        zarr_format: 3,
        node_type: "array",
        shape: [4, 3],
        data_type: "float64",
        chunk_grid: {
          name: "regular",
          configuration: { chunk_shape: [4, 3] },
        },
        chunk_key_encoding: { name: "default" },
        fill_value: "NaN",
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      },
      "array",
    ),
  ).toThrow('float64 arrays are not supported with the "bytes" codec');
});
