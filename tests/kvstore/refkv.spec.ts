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

// Inputs are refkv's fixtures, in testdata/kvstore/refkv (see its README).

import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/refkv/register_frontend.js";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { decodeFitsTiles } from "#src/third_party/refkv/core.js";
import { parseStreamChunk } from "#src/util/refkv_stream.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { TEST_DATA_DIR } from "#tests/kvstore/test_data.js";
import { sharedKvStoreContext } from "#tests/kvstore/test_util.js";

const serverFixture = httpServerFixture(constantFixture(TEST_DATA_DIR));

async function url(file: string, key = "") {
  return (await serverFixture.serverUrl()) + `refkv/${file}|refkv:${key}`;
}

async function read(file: string, key: string) {
  const { kvStoreContext } = await sharedKvStoreContext();
  const response = await kvStoreContext.read(await url(file, key), {
    throwIfMissing: true,
  });
  return new Uint8Array(await response.response.arrayBuffer());
}

async function keys(file: string) {
  const { kvStoreContext } = await sharedKvStoreContext();
  const kvStore = kvStoreContext.getKvStore(await url(file));
  const keys: string[] = [];
  const walk = async (prefix: string) => {
    const { entries, directories } = await kvStore.store.list!(prefix, {});
    keys.push(...entries.map((e) => e.key));
    for (const d of directories) await walk(`${d}/`);
  };
  await walk("");
  return keys;
}

test("virtualizes a file and reads its chunks from the file", async () => {
  for (const [file, profile, chunk] of [
    ["mp4_h264_aac.mp4", "mp4", "tracks/1/y/c/0/0/0"],
    ["edge_aperio_position.tif", "tiff", undefined],
    ["vsi_raw_gray_pyramid.vsi", "vsi", undefined],
  ] as const) {
    const root = JSON.parse(
      new TextDecoder().decode(await read(file, "zarr.json")),
    );
    expect(root.attributes.refkv_virtualized.profile, file).toBe(profile);
    const all = await keys(file);
    expect(all, file).toContain("zarr.json");
    expect(
      all.some((k) => k.startsWith("__vz__/")),
      file,
    ).toBe(false);
    // a chunk of the image, read through the archive's references to the file
    const key =
      chunk ??
      all.find((k) => /(^|\/)c\//.test(k) && !k.startsWith("refkv_source/"))!;
    expect(key, file).toBeDefined();
    const bytes = await read(file, key);
    expect(bytes.length, file).toBeGreaterThan(0);
    if (profile === "mp4") {
      // the 30 pictures of the first chunk, each at its position
      const { positions } = parseStreamChunk(bytes);
      expect(positions.filter((p) => p >= 0).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 30 }, (_, i) => i),
      );
    }
  }
});

test("rejects a file of no supported format", async () => {
  await expect(read("notes.txt", "zarr.json")).rejects.toThrow(
    "not a file of any supported format",
  );
});

test("decodes a refkv.fits_tiles chunk as refkv's Python codec does", async () => {
  // the first chunk of a RICE_1 int16 image, and the sha256 of the pixels
  // refkv.zarr's codec decodes it to (the same Rust core)
  const file = "fits_comp_rice_int16.fits";
  const meta = JSON.parse(
    new TextDecoder().decode(await read(file, "1/zarr.json")),
  );
  expect(meta.codecs[0].name).toBe("refkv.fits_tiles");
  const pixels = await decodeFitsTiles(
    await read(file, "1/c/0/0"),
    meta.codecs[0].configuration,
    meta.chunk_grid.configuration.chunk_shape,
  );
  expect(createHash("sha256").update(pixels).digest("hex").slice(0, 16)).toBe(
    "0713fe744f834c15",
  );
});
