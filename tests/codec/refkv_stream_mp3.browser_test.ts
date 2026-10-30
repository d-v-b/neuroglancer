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
import { decodeMp3 } from "#src/datasource/zarr/codec/refkv_stream/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { parseNpy } from "#src/util/npy.js";

declare const TEST_DATA_SERVER: string;

// refkv's MP3 fixtures, as testdata/codec/refkv_stream/generate_mp3.py wrote
// them: each virtualized with 256 frames a chunk and with 4 (chunks with
// lead-ins), and ffmpeg's 16-bit decoding of its frames
const NAMES = [
  "mp3_mpeg1_stereo_cbr",
  "mp3_mpeg1_mono_vbr",
  "mp3_mpeg2_mono_16k",
  "mp3_mpeg2_stereo_crc",
  "mp3_mpeg25_mono_8k",
  "mp3_info_lavc",
];
// The float samples, scaled to 16 bits and rounded, against ffmpeg's 16-bit
// output. refkv allows a mean of 0.6 units (python/tests/ir/test_mp3.py), as
// the two round differently. Chromium's decoder differs from PyAV's ffmpeg by
// up to 2 units (a sample's 2^-14, ISO/IEC 11172-4's bound for a decoder of
// full accuracy), where refkv's own test allows 1; misplaced frames would
// differ by thousands.
const MAX_DIFF = 2;
const MEAN_DIFF = 0.6;

async function get(path: string) {
  const response = await fetch(
    `${TEST_DATA_SERVER}codec/refkv_stream/mp3/${path}`,
  );
  expect([path, response.ok]).toEqual([path, true]);
  return new Uint8Array(await response.arrayBuffer());
}

/** The whole `[samples, channels]` array, decoded chunk by chunk. */
async function readArray(dir: string) {
  const meta = JSON.parse(
    new TextDecoder().decode(await get(`${dir}/zarr.json`)),
  );
  const shape: number[] = meta.shape;
  const chunkShape: number[] = meta.chunk_grid.configuration.chunk_shape;
  const codecs = parseCodecChainSpec(meta.codecs, {
    dataType: DataType.FLOAT32,
    chunkShape,
  });
  const [samples, channels] = shape;
  const out = new Float32Array(samples * channels);
  for (let q = 0; q * chunkShape[0] < samples; ++q) {
    const chunk = (await decodeArray(
      codecs,
      await get(`${dir}/c/${q}/0`),
      new AbortController().signal,
    )) as Float32Array;
    const start = q * chunkShape[0] * channels;
    out.set(
      chunk.subarray(0, Math.min(chunk.length, out.length - start)),
      start,
    );
  }
  return { out, shape };
}

test("decodes refkv's mp3 chunks as ffmpeg decodes the stream", async () => {
  for (const name of NAMES) {
    const expected = parseNpy(await get(`${name}/expected.npy`));
    for (const frames of [256, 4]) {
      const { out, shape } = await readArray(`${name}/f${frames}`);
      expect([name, frames, shape]).toEqual([name, frames, expected.shape]);
      let max = 0;
      let total = 0;
      for (let i = 0; i < out.length; ++i) {
        const scaled = Math.min(
          32767,
          Math.max(-32768, Math.round(out[i] * 32768)),
        );
        const diff = Math.abs(scaled - expected.data[i]);
        max = Math.max(max, diff);
        total += diff;
      }
      expect([
        name,
        frames,
        max <= MAX_DIFF,
        total / out.length <= MEAN_DIFF,
      ]).toEqual([name, frames, true, true]);
    }
  }
});

test("rejects an mp3 chunk whose stream has other channels than the array", async () => {
  // one chunk of the stereo fixture, read as a mono chunk
  await expect(
    decodeMp3(
      await get("mp3_mpeg1_stereo_cbr/f4/c/0/0"),
      4608,
      1,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/2 channels, not the chunk's 1/);
});

test("rejects an mp3 frame whose samples do not fit the chunk", async () => {
  // 4 frames of 1152 samples, in a chunk of 1000 rows
  await expect(
    decodeMp3(
      await get("mp3_mpeg1_stereo_cbr/f4/c/0/0"),
      1000,
      2,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/do not fit the chunk's 1000/);
});
