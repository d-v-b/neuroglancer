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
import "#src/datasource/zarr/codec/refkv_stream/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { parseChunkLengths } from "#src/datasource/zarr/metadata/chunk_grid.js";
import { decodeHevc } from "#src/sliceview/hevc/index.js";
import { DataType } from "#src/util/data_type.js";
import { parseNpy } from "#src/util/npy.js";
import { base64Bytes, parseStreamChunk } from "#src/util/refkv_stream.js";

declare const TEST_DATA_SERVER: string;

// refkv's HEVC fixtures, as testdata/codec/refkv_stream/generate_hevc.py wrote
// them: each plane array of 4:2:0 and 4:2:2 tracks of 8 to 12 bits, of 4:0:0
// tracks of 8, 10 and 12 bits (H5J files' channels among them), and of open
// GOPs and RADL pictures, with refkv's chunks and with 4 frames a chunk (each
// with its lead-in), and refkv's decoding of each array (ffmpeg's). HEVC
// decoding is exact, so the samples are compared exactly.

async function get(path: string) {
  const response = await fetch(
    `${TEST_DATA_SERVER}codec/refkv_stream/hevc/${path}`,
  );
  expect([path, response.ok]).toEqual([path, true]);
  return new Uint8Array(await response.arrayBuffer());
}

async function getJson(path: string) {
  return JSON.parse(new TextDecoder().decode(await get(path)));
}

/** The whole `[pictures, height, width]` array, decoded chunk by chunk along
 * its first axis (a regular or rectilinear grid), each chunk cropped to the
 * array. */
async function readArray(dir: string) {
  const meta = await getJson(`${dir}/zarr.json`);
  const [pictures, height, width]: number[] = meta.shape;
  const dataType =
    meta.data_type === "uint16" ? DataType.UINT16 : DataType.UINT8;
  const grid = meta.chunk_grid;
  const [lengths, chunkHeight, chunkWidth] =
    grid.name === "regular"
      ? grid.configuration.chunk_shape
      : grid.configuration.chunk_shapes;
  const out =
    dataType === DataType.UINT16
      ? new Uint16Array(pictures * height * width)
      : new Uint8Array(pictures * height * width);
  let start = 0;
  let index = 0;
  for (const [length, count] of parseChunkLengths(lengths, pictures)) {
    for (let k = 0; k < count; ++k, ++index, start += length) {
      const chunkShape = [length, chunkHeight, chunkWidth];
      const codecs = parseCodecChainSpec(meta.codecs, {
        dataType,
        chunkShape,
      });
      const chunk = (await decodeArray(
        codecs,
        await get(`${dir}/c/${index}/0/0`),
        new AbortController().signal,
      )) as Uint8Array | Uint16Array;
      expect(chunk.length).toBe(length * chunkHeight * chunkWidth);
      for (let z = 0; z < length && start + z < pictures; ++z) {
        for (let r = 0; r < height; ++r) {
          const from = (z * chunkHeight + r) * chunkWidth;
          out.set(
            chunk.subarray(from, from + width),
            ((start + z) * height + r) * width,
          );
        }
      }
    }
  }
  return { out, shape: meta.shape };
}

test("decodes refkv's HEVC chunks as ffmpeg decodes the stream", async () => {
  const index: Record<string, string[]> = await getJson("index.json");
  expect(Object.keys(index).length).toBe(32);
  for (const [name, stores] of Object.entries(index)) {
    const expected = parseNpy(await get(`${name}/expected.npy`));
    for (const store of stores) {
      const { out, shape } = await readArray(`${name}/${store}`);
      expect([name, store, shape]).toEqual([name, store, expected.shape]);
      let differing = 0;
      for (let i = 0; i < out.length; ++i) {
        if (out[i] !== expected.data[i]) ++differing;
      }
      expect([name, store, differing]).toEqual([name, store, 0]);
    }
  }
});

test("rejects the u plane of a 4:0:0 stream", async () => {
  const meta = await getJson("h5j_two_channels/Channel_0_0/f0/zarr.json");
  meta.codecs[0].configuration.plane = "u";
  expect(() =>
    parseCodecChainSpec(meta.codecs, {
      dataType: DataType.UINT16,
      chunkShape: meta.chunk_grid.configuration.chunk_shape,
    }),
  ).toThrow(/a 4:0:0 HEVC stream has no u plane, only y/);
});

async function chunkOf(dir: string) {
  const meta = await getJson(`${dir}/zarr.json`);
  const setup = base64Bytes(meta.codecs[0].configuration.setup);
  return { setup, ...parseStreamChunk(await get(`${dir}/c/0/0/0`)) };
}

test("rejects a chunk whose pictures are not the stream's format", async () => {
  // 12-bit 4:0:0 pictures, decoded as 8-bit ones
  const { setup, units, positions } = await chunkOf(
    "h5j_two_channels/Channel_0_0/f0",
  );
  await expect(
    decodeHevc(setup, units, positions, 20, 8, "4:0:0"),
  ).rejects.toThrow(/decodes to 4:0:0 of 12 bits, not the stream's 4:0:0 of 8/);
});

test("rejects a picture outside the chunk", async () => {
  // 20 pictures, in a chunk of 10
  const { setup, units, positions } = await chunkOf(
    "h5j_two_channels/Channel_0_0/f0",
  );
  await expect(
    decodeHevc(setup, units, positions, 10, 12, "4:0:0"),
  ).rejects.toThrow(/a picture at 1\d is outside the chunk's 10/);
});

test("rejects a frame whose NAL unit overruns it", async () => {
  const { setup, units, positions } = await chunkOf(
    "h5j_two_channels/Channel_0_0/f0",
  );
  const cut = [units[0].subarray(0, units[0].length - 1), ...units.slice(1)];
  await expect(
    decodeHevc(setup, cut, positions, 20, 12, "4:0:0"),
  ).rejects.toThrow(/HEVC frame 0's NAL unit of \d+ bytes overruns its \d+/);
});

test("rejects a frame that ends inside a NAL unit's length", async () => {
  const { setup, units, positions } = await chunkOf(
    "h5j_two_channels/Channel_0_0/f0",
  );
  const cut = [Uint8Array.of(0, 0), ...units.slice(1)];
  await expect(
    decodeHevc(setup, cut, positions, 20, 12, "4:0:0"),
  ).rejects.toThrow(/HEVC frame 0 ends inside a NAL unit's length/);
});

test("rejects a chunk the decoder fails on", async () => {
  // the parameter sets of another stream: refkv's 8-bit 4:2:0 track
  const { units, positions } = await chunkOf("h5j_two_channels/Channel_0_0/f0");
  const other = await chunkOf("mp4_hevc_aac/tracks_1_y/f0");
  await expect(
    decodeHevc(other.setup, units, positions, 20, 12, "4:0:0"),
  ).rejects.toThrow(
    /^refkv.stream: libde265 fails to decode the HEVC chunk: \w/,
  );
});
