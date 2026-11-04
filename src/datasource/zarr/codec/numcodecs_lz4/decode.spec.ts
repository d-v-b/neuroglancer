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
import { decodeNumcodecsLz4 } from "#src/datasource/zarr/codec/numcodecs_lz4/decode.js";

test("decodes what numcodecs.LZ4(1).encode writes", () => {
  const encoded = Uint8Array.from(
    atob("nQAAAP8BAAECAwQFBgcICQoLDA0ODxAAXW5oZWxsbyAGAFB3b3JsZA=="),
    (c) => c.charCodeAt(0),
  );
  const repeated = Array.from({ length: 16 * 8 }, (_, i) => i % 16);
  const text = "hello hello hello hello world";
  expect(Array.from(decodeNumcodecsLz4(encoded))).toEqual([
    ...repeated,
    ...Array.from(text, (c) => c.charCodeAt(0)),
  ]);
});

test("rejects bytes too few for the size prefix", () => {
  expect(() => decodeNumcodecsLz4(Uint8Array.of(1, 0))).toThrow(/size prefix/);
});
