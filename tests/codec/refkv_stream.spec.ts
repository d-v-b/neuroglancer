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
  ).toThrow(
    "aac streams are not decoded, only h264 video and mp3 and flac audio",
  );
});

// flac_mono_16's setup, 16 bits, and flac_bitwise_8's and flac_mono_24's
const flac = (setup: string) => [
  { name: "refkv.stream", configuration: { format: "flac", setup } },
];
const FLAC_16 = "ZkxhQ4AAACIEAAQAAAQyAAUZA+gA8AAAH0BgPGM/L5AWonufOnS9+BTZ";
const FLAC_8 = "ZkxhQ4AAACIAQABAAAAAAAAAAfQAcAAAAZAi9OiyvIHmzDLpcKt0fJDl";
const FLAC_24 = "ZkxhQ4AAACIQABAAAAYpACM0F3ABcAAAEsChPpOIPDN8+CXdVCS6Z2Wd";

test("resolves a flac stream of [samples, channels] chunks of its integers", () => {
  for (const [setup, dataType] of [
    [FLAC_8, DataType.INT8],
    [FLAC_16, DataType.INT16],
    [FLAC_24, DataType.INT32],
  ] as const) {
    const spec = parseCodecChainSpec(flac(setup), {
      dataType,
      chunkShape: [1024, 1],
    });
    expect(spec[CodecKind.arrayToBytes]).toEqual({
      kind: CodecKind.arrayToBytes,
      name: "refkv.stream",
      configuration: { format: "flac", setup },
    });
  }
});

test("rejects flac samples of another type than their bits'", () => {
  expect(() =>
    parseCodecChainSpec(flac(FLAC_24), {
      dataType: DataType.INT16,
      chunkShape: [1024, 1],
    }),
  ).toThrow("flac samples of 24 bits are int32, not int16");
});

test("rejects a flac chunk that is not [samples, channels]", () => {
  expect(() =>
    parseCodecChainSpec(flac(FLAC_16), {
      dataType: DataType.INT16,
      chunkShape: [1024],
    }),
  ).toThrow("a flac chunk is [samples, channels], not [1024]");
});

test("rejects a flac stream without its setup", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "refkv.stream", configuration: { format: "flac" } }],
      { dataType: DataType.INT16, chunkShape: [1024, 1] },
    ),
  ).toThrow("setup");
});

test("rejects a flac setup that is not STREAMINFO", () => {
  expect(() =>
    parseCodecChainSpec(flac("ZkxhQw=="), {
      dataType: DataType.INT16,
      chunkShape: [1024, 1],
    }),
  ).toThrow("a flac setup is fLaC and a STREAMINFO block, 42 bytes");
});
