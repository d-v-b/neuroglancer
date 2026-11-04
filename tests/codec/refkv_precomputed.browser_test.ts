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

// Inputs are refkv's fixtures, in testdata/codec/refkv_precomputed (see its
// generate.py): each array a plain Zarr store, with the values refkv's Python
// codec reads from it.

import { expect, test, vi } from "vitest";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import "#src/datasource/zarr/codec/resolvers.js";
import "#src/datasource/zarr/codec/refkv_precomputed/decode.js";
import {
  applySharding,
  decodeArray,
} from "#src/datasource/zarr/codec/decode.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV3Metadata } from "#src/datasource/zarr/metadata/parse.js";
import type {
  ByteRange,
  DriverReadOptions,
  KvStore,
  ReadResponse,
} from "#src/kvstore/index.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";

declare const TEST_DATA_SERVER: string;

// The caches of a real chunk manager need a running one; these keep what a
// cache must, one value per key.
vi.mock("#src/chunk_manager/generic_file_source.js", () => ({
  SimpleAsyncCache: class {
    private values = new Map<string, Promise<unknown>>();
    constructor(
      _chunkManager: unknown,
      private options: {
        get: (key: unknown, o: unknown) => Promise<{ data: unknown }>;
        encodeKey?: (key: unknown) => string;
      },
    ) {}
    get(key: unknown, options: unknown) {
      const encoded = (this.options.encodeKey ?? JSON.stringify)(key);
      let value = this.values.get(encoded);
      if (value === undefined) {
        value = this.options.get(key, options).then((r) => r.data);
        this.values.set(encoded, value);
      }
      return value;
    }
    dispose() {}
  },
}));

const chunkManager = { addRef: () => chunkManager } as unknown as ChunkManager;

const signal = new AbortController().signal;

async function get(path: string) {
  const response = await fetch(
    `${TEST_DATA_SERVER}codec/refkv_precomputed/${path}`,
  );
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
}

/** The fixture's keys, recording the ranges read. */
function store(volume: string) {
  const reads: { key: string; offset?: number; length?: number }[] = [];
  const kvStore = {
    getUrl: (key: string) => key,
    supportsOffsetReads: true,
    supportsSuffixReads: true,
    stat: async () => undefined,
    read: async (
      key: string,
      { byteRange }: DriverReadOptions,
    ): Promise<ReadResponse | undefined> => {
      if (byteRange !== undefined && "suffixLength" in byteRange) {
        throw new Error("unexpected suffix read");
      }
      const data = await get(`${volume}/${key}`);
      if (data === undefined) return undefined;
      const { offset = 0, length = data.length } = byteRange ?? {};
      reads.push({ key, ...byteRange });
      return {
        response: new Response(data.slice(offset, offset + length)),
        offset,
        length,
        totalSize: data.length,
      };
    },
  } as KvStore;
  return { kvStore, reads };
}

async function openArray(volume: string, array: string) {
  const json = JSON.parse(
    new TextDecoder().decode(await get(`${volume}/${array}/zarr.json`)),
  );
  const metadata = parseV3Metadata(json, "array") as ArrayMetadata;
  const { kvStore, reads } = store(volume);
  const chunks = applySharding(chunkManager, metadata.codecs, {
    store: kvStore,
    path: `${array}/`,
  });
  return { metadata, chunks, reads };
}

/**
 * Reads the array's read chunk at `position` (in the array's order) as the
 * Zarr chunk source does: undefined if it is missing.
 */
async function readChunk(
  { metadata, chunks }: Awaited<ReturnType<typeof openArray>>,
  position: number[],
) {
  const { readChunkShape } = metadata.codecs.layoutInfo[0];
  const keyCoords = position.map((p, i) =>
    Math.floor((p * readChunkShape[i]) / metadata.chunkShape[i]),
  );
  const key = chunks.getChunkKey(
    Array.from(position).reverse(),
    ["c", ...keyCoords].join("/"),
  );
  const response = await chunks.kvStore.read(key, { signal });
  if (response === undefined) return undefined;
  return decodeArray(
    chunks.decodeCodecs,
    new Uint8Array(await response.response.arrayBuffer()),
    signal,
  );
}

/** The whole array, read chunk by read chunk as Neuroglancer reads it. */
async function readArray(opened: Awaited<ReturnType<typeof openArray>>) {
  const { metadata } = opened;
  const { shape, dataType, rank } = metadata;
  const { readChunkShape } = metadata.codecs.layoutInfo[0];
  const numElements = shape.reduce((a, b) => a * b, 1);
  const output = makeDataTypeArrayView(
    dataType,
    new ArrayBuffer(numElements * DATA_TYPE_BYTES[dataType]),
  ) as any;
  const strides = new Array<number>(rank).fill(1);
  const chunkStrides = new Array<number>(rank).fill(1);
  for (let i = rank - 2; i >= 0; --i) {
    strides[i] = strides[i + 1] * shape[i + 1];
    chunkStrides[i] = chunkStrides[i + 1] * readChunkShape[i + 1];
  }
  const grid = shape.map((n, i) => Math.ceil(n / readChunkShape[i]));
  const visit = async (position: number[]): Promise<void> => {
    if (position.length < rank) {
      for (let i = 0; i < grid[position.length]; ++i) {
        await visit([...position, i]);
      }
      return;
    }
    const chunk = (await readChunk(opened, position)) as any;
    if (chunk === undefined) return;
    expect(chunk.length).toBe(readChunkShape.reduce((a, b) => a * b, 1));
    const copy = (dim: number, from: number, to: number) => {
      if (dim === rank) {
        output[to] = chunk[from];
        return;
      }
      const start = position[dim] * readChunkShape[dim];
      const end = Math.min(start + readChunkShape[dim], shape[dim]);
      for (let i = start; i < end; ++i) {
        copy(
          dim + 1,
          from + (i - start) * chunkStrides[dim],
          to + i * strides[dim],
        );
      }
    };
    copy(0, 0, 0);
  };
  await visit([]);
  return output;
}

async function expected(
  volume: string,
  array: string,
  { dataType }: ArrayMetadata,
) {
  const bytes = await get(`${volume}/${array}.expected`);
  return makeDataTypeArrayView(dataType, bytes!.buffer) as any;
}

test("reads each array as refkv's Python codec does", async () => {
  for (const [volume, array, tolerance] of [
    ["precomputed_float32", "0", 0],
    ["precomputed_png", "0", 0],
    // a chunk past the grid along x and clipped ones; one is missing
    ["precomputed_raw_clipped", "0", 0],
    ["precomputed_raw_clipped", "1", 0],
    ["precomputed_segmentation", "0", 0],
    ["precomputed_segmentation_sharded", "0", 0],
    // jpgjs rounds its inverse DCT other than as libjpeg does, by at most 1
    ["precomputed_sharded_jpeg", "0", 1],
    ["precomputed_sharded_raw", "0", 0],
    ["precomputed_sharded_raw", "1", 0],
  ] as const) {
    const opened = await openArray(volume, array);
    const values = await readArray(opened);
    const want = await expected(volume, array, opened.metadata);
    expect(values.length, volume).toBe(want.length);
    let max = 0;
    for (let i = 0; i < want.length; ++i) {
      max = Math.max(max, Math.abs(Number(values[i]) - Number(want[i])));
    }
    expect(max, `${volume}/${array}`).toBeLessThanOrEqual(tolerance);
  }
});

test("reads a chunk of a shard through its indexes, never the whole shard", async () => {
  const opened = await openArray("precomputed_sharded_raw", "0");
  const { reads } = opened;
  await readChunk(opened, [0, 1, 0]);
  // the position, which an archive holds as a literal and takes no request,
  // then the shard index's entry, the minishard's index and the chunk
  expect(reads.map((r) => r.offset === undefined)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(reads.map((r) => r.length).slice(0, 2)).toEqual([12, 16]);
  // and only the chunk, once its minishard's index is known
  reads.length = 0;
  await readChunk(opened, [0, 1, 1]);
  expect(reads.length).toBe(1);
});

test("a chunk its shard does not hold reads as missing", async () => {
  const opened = await openArray("precomputed_sharded_raw", "0");
  // one the shard leaves out; a whole shard the store does not have; and one
  // past the grid, in a box that runs past it
  for (const position of [
    [0, 0, 1],
    [0, 4, 4],
    [0, 0, 5],
  ]) {
    expect(await readChunk(opened, position), `${position}`).toBeUndefined();
  }
});

test("reads a shard's chunks of several channels", async () => {
  // a volume of 2 chunks, a shard's box, of 2 channels; the second chunk is
  // the one in the second minishard
  const values = (i: number) =>
    Uint8Array.from({ length: 16 }, (_, k) => 10 * i + k);
  const entry = (id: number, offset: number) =>
    BigUint64Array.of(BigInt(id), BigInt(offset), 16n);
  const shard = new Uint8Array(32 + 16 * 2 + 24 * 2);
  const view = new DataView(shard.buffer);
  // the minishards' indexes follow the chunks
  for (const [i, start] of [
    [0, 32],
    [1, 56],
  ]) {
    view.setBigUint64(i * 16, BigInt(start), true);
    view.setBigUint64(i * 16 + 8, BigInt(start + 24), true);
    shard.set(values(i), 32 + i * 16);
    shard.set(new Uint8Array(entry(i, i * 16).buffer), 32 + start);
  }
  const zarrChunk = new Uint8Array(12 + shard.length);
  zarrChunk.set(shard, 12);
  const metadata = parseV3Metadata(
    {
      zarr_format: 3,
      node_type: "array",
      shape: [2, 2, 2, 4],
      data_type: "uint8",
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: [2, 2, 2, 4] },
      },
      chunk_key_encoding: { name: "default" },
      fill_value: 0,
      codecs: [
        {
          name: "refkv.precomputed",
          configuration: {
            encoding: "raw",
            size: [4, 2, 2],
            chunk_size: [2, 2, 2],
            sharding: {
              preshift_bits: 0,
              minishard_bits: 1,
              minishard_index_encoding: "raw",
              data_encoding: "raw",
            },
          },
        },
      ],
    },
    "array",
  ) as ArrayMetadata;
  const kvStore = {
    getUrl: (key: string) => key,
    supportsOffsetReads: true,
    supportsSuffixReads: true,
    stat: async () => undefined,
    read: async (_key: string, { byteRange }: DriverReadOptions) => {
      const { offset, length } = byteRange as ByteRange;
      return {
        response: new Response(zarrChunk.slice(offset, offset + length)),
        offset,
        length,
        totalSize: zarrChunk.length,
      };
    },
  } as KvStore;
  const chunks = applySharding(chunkManager, metadata.codecs, {
    store: kvStore,
    path: "",
  });
  expect(metadata.codecs.layoutInfo[0].readChunkShape).toEqual([2, 2, 2, 2]);
  for (const x of [0, 1]) {
    const response = await chunks.kvStore.read(
      chunks.getChunkKey([x, 0, 0, 0], "c/0/0/0/0"),
      { signal },
    );
    const decoded = await decodeArray(
      chunks.decodeCodecs,
      new Uint8Array(await response!.response.arrayBuffer()),
      signal,
    );
    expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(values(x)));
  }
});

async function arrayMetadata(volume: string, array = "0") {
  const json = JSON.parse(
    new TextDecoder().decode(await get(`${volume}/${array}/zarr.json`)),
  );
  return { json, metadata: parseV3Metadata(json, "array") as ArrayMetadata };
}

function replaceObject(chunk: Uint8Array, object: Uint8Array) {
  const replaced = new Uint8Array(12 + object.length);
  replaced.set(chunk.subarray(0, 12));
  replaced.set(object, 12);
  return replaced;
}

function decode(metadata: ArrayMetadata, chunk: Uint8Array) {
  return decodeArray(
    metadata.codecs,
    chunk as Uint8Array<ArrayBuffer>,
    signal,
  ) as Promise<any>;
}

test("fills a clipped chunk with the array's fill value", async () => {
  const volume = "precomputed_raw_clipped";
  const { json } = await arrayMetadata(volume);
  json.fill_value = 200;
  const metadata = parseV3Metadata(json, "array") as ArrayMetadata;
  const want = await expected(volume, "0", metadata);
  // The volume is 10 x 7 x 5 in chunks of 4 x 4 x 2: this chunk holds 2, 3
  // and 1 of those. A raw object may hold them alone, or be a whole chunk's,
  // which a writer padded with values that are not the volume's.
  const stored = (await get(`${volume}/0/c/2/1/2`))!;
  const padded = new Uint8Array(2 * 4 * 4).fill(99);
  for (let y = 0; y < 3; ++y) {
    for (let x = 0; x < 2; ++x) {
      padded[y * 4 + x] = stored[12 + y * 2 + x];
    }
  }
  for (const chunk of [stored, replaceObject(stored, padded)]) {
    const values = await decode(metadata, chunk);
    expect(values.length).toBe(32);
    for (let z = 0; z < 2; ++z) {
      for (let y = 0; y < 4; ++y) {
        for (let x = 0; x < 4; ++x) {
          expect(values[(z * 4 + y) * 4 + x]).toBe(
            z < 1 && y < 3 && x < 2
              ? want[((4 + z) * 7 + 4 + y) * 10 + 8 + x]
              : 200,
          );
        }
      }
    }
  }
});

test("takes off a gzip or Zstandard coding its bytes show", async () => {
  const volume = "precomputed_codings_bare";
  const { metadata } = await arrayMetadata(volume);
  const want = await expected(volume, "0", metadata);
  // not coded, gzip, and Zstandard; [c, z, y, x] of 2, 2, 4, 16 in chunks of
  // 4 along x
  for (const x of [0, 1, 3]) {
    const values = await decode(
      metadata,
      (await get(`${volume}/0/c/0/0/0/${x}`))!,
    );
    const rows = values.length / 4;
    for (let i = 0; i < rows; ++i) {
      for (let k = 0; k < 4; ++k) {
        expect(values[i * 4 + k]).toBe(want[i * 16 + x * 4 + k]);
      }
    }
  }
});

test("refuses a chunk with no position", async () => {
  const { metadata } = await arrayMetadata("precomputed_float32");
  await expect(decode(metadata, new Uint8Array(11))).rejects.toThrow(
    "a chunk of 11 bytes has no position",
  );
});

test("refuses a chunk past the grid", async () => {
  const volume = "precomputed_float32";
  const { metadata } = await arrayMetadata(volume);
  const moved = (await get(`${volume}/0/c/0/0/0`))!;
  new DataView(moved.buffer).setUint32(0, 2, true);
  await expect(decode(metadata, moved)).rejects.toThrow(
    "a chunk at 2,0,0 is past the grid",
  );
});

test("refuses a raw chunk of another length", async () => {
  const volume = "precomputed_float32";
  const { metadata } = await arrayMetadata(volume);
  const chunk = (await get(`${volume}/0/c/0/0/0`))!;
  const coded = await new Response(
    new Response(new Uint8Array(5)).body!.pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).arrayBuffer();
  await expect(
    decode(metadata, replaceObject(chunk, new Uint8Array(coded))),
  ).rejects.toThrow("a raw chunk is 5 bytes, not 32");
});

test("refuses a brotli chunk", async () => {
  const volume = "precomputed_codings_bare";
  const { metadata } = await arrayMetadata(volume);
  await expect(
    decode(metadata, (await get(`${volume}/0/c/0/0/0/2`))!),
  ).rejects.toThrow("this reader does not decode brotli");
});

test("refuses a JPEG with subsampled chroma", async () => {
  const volume = "precomputed_jpeg_rgb";
  const { metadata } = await arrayMetadata(volume);
  await expect(
    decode(metadata, (await get(`${volume}/0/c/0/0/0/0`))!),
  ).rejects.toThrow("a JPEG with subsampled chroma is not supported");
});

test("refuses a JPEG of 12 bits", async () => {
  const volume = "precomputed_jpeg_rgb";
  const { metadata } = await arrayMetadata(volume);
  const chunk = (await get(`${volume}/0/c/0/0/0/0`))!;
  const frame = chunk.findIndex(
    (byte, i) => byte === 0xff && chunk[i + 1] === 0xc0,
  );
  chunk[frame + 4] = 12;
  await expect(decode(metadata, chunk)).rejects.toThrow(
    "a JPEG of 12 bits is not supported",
  );
});

test("refuses a JPEG of another shape than its chunk's", async () => {
  const opened = await openArray("precomputed_sharded_jpeg", "0");
  const { chunks } = opened;
  const response = await chunks.kvStore.read(
    chunks.getChunkKey([0, 0, 0], "c/0/0/0"),
    { signal },
  );
  const chunk = new Uint8Array(await response!.response.arrayBuffer());
  // the last chunk along z, clipped to 1 slice of 2
  new DataView(chunk.buffer).setUint32(8, 1, true);
  await expect(decodeArray(chunks.decodeCodecs, chunk, signal)).rejects.toThrow(
    "JPEG data does not have the expected dimensions",
  );
});

test("refuses a PNG of several 16-bit channels", async () => {
  const volume = "precomputed_png";
  const { json } = await arrayMetadata(volume);
  json.shape = [2, ...json.shape];
  json.chunk_grid.configuration.chunk_shape = [
    2,
    ...json.chunk_grid.configuration.chunk_shape,
  ];
  json.dimension_names = ["c", ...json.dimension_names];
  const metadata = parseV3Metadata(json, "array") as ArrayMetadata;
  await expect(
    decode(metadata, (await get(`${volume}/0/c/0/0/0`))!),
  ).rejects.toThrow("a PNG of 2 channels of 16 bits is not supported");
});

test("refuses a compressed_segmentation stream cut short", async () => {
  const volume = "precomputed_segmentation";
  const { metadata } = await arrayMetadata(volume);
  const chunk = (await get(`${volume}/0/c/0/0/0`))!;
  await expect(
    decode(metadata, chunk.subarray(0, chunk.length - 8).slice()),
  ).rejects.toThrow("compressed_segmentation: a block's table past");
});

test("refuses a shard whose position is not the start of its box", async () => {
  const volume = "precomputed_sharded_raw";
  const { metadata } = await arrayMetadata(volume);
  const { kvStore } = store(volume);
  const read = kvStore.read.bind(kvStore);
  kvStore.read = async (key, options) => {
    const response = (await read(key, options))!;
    const bytes = new Uint8Array(await response.response.arrayBuffer());
    new DataView(bytes.buffer).setUint32(0, 1, true);
    return { ...response, response: new Response(bytes) };
  };
  const chunks = applySharding(chunkManager, metadata.codecs, {
    store: kvStore,
    path: "0/",
  });
  await expect(
    chunks.kvStore.read(chunks.getChunkKey([0, 0, 0], "c/0/0/0"), { signal }),
  ).rejects.toThrow("which is not the start of a box within the grid");
});

test("refuses a minishard index range that runs backwards", async () => {
  const volume = "precomputed_sharded_raw";
  const { metadata } = await arrayMetadata(volume);
  const { kvStore } = store(volume);
  const read = kvStore.read.bind(kvStore);
  kvStore.read = async (key, options) => {
    const response = (await read(key, options))!;
    if (response.length !== 16) return response;
    const bytes = new Uint8Array(await response.response.arrayBuffer());
    new DataView(bytes.buffer).setBigUint64(0, 1000n, true);
    return { ...response, response: new Response(bytes) };
  };
  const chunks = applySharding(chunkManager, metadata.codecs, {
    store: kvStore,
    path: "0/",
  });
  await expect(
    chunks.kvStore.read(chunks.getChunkKey([0, 0, 0], "c/0/0/0"), { signal }),
  ).rejects.toThrow("Invalid minishard index range");
});
