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
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import { expect, test } from "vitest";
import "#src/datasource/zarr/codec/resolvers.js";
import "#src/datasource/zarr/codec/refkv_grib/decode.js";
import "#src/datasource/zarr/codec/refkv_precomputed/decode.js";
import { decodeArray } from "#src/datasource/zarr/codec/decode.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";
import { decodeFitsTiles } from "#src/third_party/refkv/core.js";
import { DataType } from "#src/util/data_type.js";
import { parseStreamChunk } from "#src/util/refkv_stream.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { TEST_DATA_DIR } from "#tests/kvstore/test_data.js";
import { sharedKvStoreContext } from "#tests/kvstore/test_util.js";

// S3's ListObjectsV2 of the bucket `/refkv/`, which is how refkv lists a store
function listObjects(req: http.IncomingMessage, res: http.ServerResponse) {
  const { pathname, searchParams } = new URL(req.url!, "http://localhost");
  if (pathname !== "/refkv/" || searchParams.get("list-type") !== "2") {
    res.emit("next");
    return;
  }
  const prefix = searchParams.get("prefix")!;
  const bucket = path.join(TEST_DATA_DIR, "refkv");
  const contents = fs
    .readdirSync(path.join(bucket, prefix), { recursive: true })
    .map((name) => `${prefix}${String(name).replaceAll(path.sep, "/")}`)
    .filter((key) => fs.statSync(path.join(bucket, key)).isFile())
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><Size>${fs.statSync(path.join(bucket, key)).size}</Size></Contents>`,
    );
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(
    `<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`,
  );
}

const serverFixture = httpServerFixture(constantFixture(TEST_DATA_DIR), [
  listObjects,
]);

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

test("zarrifies a file and reads its chunks from the file", async () => {
  for (const [file, profile, chunk] of [
    ["mp4_h264_aac.mp4", "mp4", "tracks/1/y/c/0/0/0"],
    ["edge_aperio_position.tif", "tiff", undefined],
    ["vsi_raw_gray_pyramid.vsi", "vsi", undefined],
  ] as const) {
    const root = JSON.parse(
      new TextDecoder().decode(await read(file, "zarr.json")),
    );
    expect(root.attributes.refkv_zarrified.profile, file).toBe(profile);
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

test("zarrifies a precomputed store and reads its chunks from its objects", async () => {
  for (const [store, chunk, position, object] of [
    ["precomputed_float32/", "0/c/0/0/0", [0, 0, 0], "0/0-2_0-2_0-2"],
    ["precomputed_float32/", "0/c/0/0/1", [1, 0, 0], "0/2-4_0-2_0-2"],
    // a whole shard, the box of chunks it holds
    ["precomputed_sharded_raw/", "1/c/0/0/0", [0, 0, 0], "b/0.shard"],
  ] as const) {
    const root = JSON.parse(
      new TextDecoder().decode(await read(store, "zarr.json")),
    );
    expect(root.attributes.refkv_zarrified.profile, store).toBe("precomputed");
    // the chunk's position on the grid, a literal, and then the object
    const value = await read(store, chunk);
    expect(
      Array.from(new Uint32Array(value.slice(0, 12).buffer)),
      chunk,
    ).toEqual(position);
    expect(value.slice(12), chunk).toEqual(
      new Uint8Array(
        fs.readFileSync(path.join(TEST_DATA_DIR, "refkv", store, object)),
      ),
    );
  }
});

test("decodes a refkv.precomputed chunk of a zarrified store", async () => {
  const store = "precomputed_float32/";
  const json = JSON.parse(
    new TextDecoder().decode(await read(store, "0/zarr.json")),
  );
  expect(json.codecs[0].name).toBe("refkv.precomputed");
  const meta = parseV3Metadata(json, "array") as ArrayMetadata;
  const values = await decodeArray(
    meta.codecs,
    await read(store, "0/c/0/0/0"),
    new AbortController().signal,
  );
  // raw and little-endian, x fastest in the object as in the array's [z, y, x]
  const object = fs.readFileSync(
    path.join(TEST_DATA_DIR, "refkv", store, "0/0-2_0-2_0-2"),
  );
  expect(values).toBeInstanceOf(Float32Array);
  expect(Array.from(values as Float32Array)).toEqual(
    Array.from(
      new Float32Array(object.buffer, object.byteOffset, object.byteLength / 4),
    ),
  );
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

test("decodes a float64 refkv.grib array as float32", async () => {
  // a field of 12 x 16 points, 12 of them missing (a bitmap), and the values
  // eccodes decodes it to (refkv's fixtures/grib/expected), rounded to float32
  const file = "grib_bitmap.grib2";
  // the variable, beside the grid's coordinates
  let path = "";
  let json: any;
  for (const k of await keys(file)) {
    if (!/^grid0\/[^/]+\/zarr\.json$/.test(k)) continue;
    json = JSON.parse(new TextDecoder().decode(await read(file, k)));
    path = k.slice(0, -"/zarr.json".length);
    if (json.codecs[0].name === "refkv.grib") break;
  }
  expect(json.codecs[0].name).toBe("refkv.grib");
  expect(json.data_type).toBe("float64");
  const meta = parseV3Metadata(json, "array") as ArrayMetadata;
  expect(meta.dataType).toBe(DataType.FLOAT32);
  const key = ["c", ...meta.chunkShape.map(() => 0)].join("/");
  const values = await decodeArray(
    meta.codecs,
    await read(file, `${path}/${key}`),
    new AbortController().signal,
  );
  expect(values).toBeInstanceOf(Float32Array);
  const npy = (await (
    await fetch(
      (await serverFixture.serverUrl()) + "refkv/grib_bitmap.expected.npy",
    )
  ).arrayBuffer()) as ArrayBuffer;
  const header = 10 + new DataView(npy).getUint16(8, true);
  expect(Array.from(values as Float32Array)).toEqual(
    Array.from(new Float64Array(npy, header), Math.fround),
  );
});
