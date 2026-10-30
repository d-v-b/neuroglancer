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
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { decodeFlac } from "#src/datasource/zarr/codec/refkv_stream/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { parseNpy } from "#src/util/npy.js";

declare const TEST_DATA_SERVER: string;

// refkv's FLAC fixtures, as testdata/codec/refkv_stream/generate_flac.py wrote
// them: the shards of each file's samples, a frame an inner chunk, and refkv's
// decoding of them, whose MD5 is the stream's. FLAC is lossless, so the
// samples are compared exactly.
const NAMES = [
  "flac_bitwise_8",
  "flac_bitwise_12_side",
  "flac_bitwise_20_mid",
  "flac_bitwise_32",
  "flac_bitwise_streaminfo_codes",
  "flac_bitwise_uncommon",
  "flac_many_frames",
  "flac_mono_16",
  "flac_mono_24",
  "flac_single_frame",
  "flac_stereo_16_seektable",
  "flac_stereo_24",
];

async function get(path: string) {
  const response = await fetch(
    `${TEST_DATA_SERVER}codec/refkv_stream/flac/${path}`,
  );
  expect([path, response.ok]).toEqual([path, true]);
  return new Uint8Array(await response.arrayBuffer());
}

/** The whole `[samples, channels]` array, decoded inner chunk by inner chunk
 * from the shards, whose index (16 bytes a chunk and a CRC-32C) ends each. */
async function readArray(name: string) {
  const meta = JSON.parse(
    new TextDecoder().decode(await get(`${name}/zarr.json`)),
  );
  const shape: number[] = meta.shape;
  const shardShape: number[] = meta.chunk_grid.configuration.chunk_shape;
  const codecs = parseCodecChainSpec(meta.codecs, {
    dataType: DataType[meta.data_type.toUpperCase() as keyof typeof DataType],
    chunkShape: shardShape,
  });
  const inner = codecs.shardingInfo!.subChunkCodecs;
  const [block] = codecs.shardingInfo!.subChunkShape;
  const perShard = shardShape[0] / block;
  const [samples, channels] = shape;
  let out: Int8Array | Int16Array | Int32Array | undefined;
  for (let q = 0; q * shardShape[0] < samples; ++q) {
    const shard = await get(`${name}/c/${q}/0`);
    const index = new DataView(
      shard.buffer,
      shard.byteLength - 16 * perShard - 4,
    );
    for (let k = 0; k < perShard; ++k) {
      const offset = index.getBigUint64(16 * k, true);
      const size = index.getBigUint64(16 * k + 8, true);
      if (offset === 2n ** 64n - 1n) continue;
      const chunk = (await decodeArray(
        inner,
        shard.subarray(Number(offset), Number(offset + size)),
        new AbortController().signal,
      )) as Int8Array | Int16Array | Int32Array;
      const start = (q * perShard + k) * block * channels;
      out ??= new (chunk.constructor as Int32ArrayConstructor)(
        samples * channels,
      );
      out.set(
        chunk.subarray(0, Math.min(chunk.length, out.length - start)),
        start,
      );
    }
  }
  return { out: out!, shape };
}

test("decodes refkv's flac shards to the stream's samples", async () => {
  for (const name of NAMES) {
    const expected = parseNpy(await get(`${name}/expected.npy`));
    const { out, shape } = await readArray(name);
    expect([name, shape]).toEqual([name, expected.shape]);
    expect([name, out.constructor]).toEqual([name, expected.data.constructor]);
    let differ = 0;
    for (let i = 0; i < out.length; ++i) {
      if (out[i] !== expected.data[i]) ++differ;
    }
    expect([name, differ]).toEqual([name, 0]);
  }
});

const SETUP = "ZkxhQ4AAACIEAAQAAAQyAAUZA+gA8AAAH0BgPGM/L5AWonufOnS9+BTZ";

/** Inner chunk 0 of flac_mono_16 (16-bit mono, 1024 samples a frame). */
async function firstChunk() {
  const shard = await get("flac_mono_16/c/0/0");
  const index = new DataView(shard.buffer, shard.byteLength - 16 * 8 - 4);
  return shard.subarray(0, Number(index.getBigUint64(8, true)));
}

test("rejects a flac chunk whose stream has other channels than the array", async () => {
  await expect(
    decodeFlac(
      SETUP,
      await firstChunk(),
      new Int16Array(2048),
      2,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/1 channels, not the chunk's 2/);
});

test("rejects a flac frame whose samples do not fit the chunk", async () => {
  await expect(
    decodeFlac(
      SETUP,
      await firstChunk(),
      new Int16Array(1000),
      1,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/do not fit the chunk's 1000/);
});
