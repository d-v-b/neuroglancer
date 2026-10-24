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
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

const mp3 = [{ name: "refkv.stream", configuration: { format: "mp3" } }];

test("resolves an mp3 stream of [samples, channels] float32 chunks", () => {
  const spec = parseCodecChainSpec(mp3, {
    dataType: DataType.FLOAT32,
    chunkShape: [294912, 2],
  });
  expect(spec[CodecKind.arrayToBytes]).toEqual({
    kind: CodecKind.arrayToBytes,
    name: "refkv.stream",
    configuration: { format: "mp3" },
  });
});

test("rejects mp3 samples that are not float32", () => {
  expect(() =>
    parseCodecChainSpec(mp3, {
      dataType: DataType.INT16,
      chunkShape: [294912, 2],
    }),
  ).toThrow("mp3 samples are float32, not int16");
});

test("rejects an mp3 chunk that is not [samples, channels]", () => {
  expect(() =>
    parseCodecChainSpec(mp3, {
      dataType: DataType.FLOAT32,
      chunkShape: [294912],
    }),
  ).toThrow("an mp3 chunk is [samples, channels], not [294912]");
});

test("rejects a stream format it does not decode", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "refkv.stream",
          configuration: { format: "aac", setup: "EZA=" },
        },
      ],
      { dataType: DataType.FLOAT32, chunkShape: [1024, 2] },
    ),
  ).toThrow("aac streams are not decoded, only h264 video and mp3 audio");
});
