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

/**
 * @file The `refkv.precomputed` array-to-bytes codec (refkv's
 * [spec/zarrify/precomputed.md](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/precomputed.md#6-the-codec-refkvprecomputed)):
 * a Zarr chunk is the 12-byte position on the chunk grid of its first chunk,
 * then one object of a Neuroglancer precomputed volume: a chunk, or a shard
 * whose box of chunks the Zarr chunk is. A sharded array is read as a
 * `sharding_indexed` one is: Neuroglancer's chunk is the precomputed chunk,
 * found through the shard's index (see decode.ts), and a shard is never read
 * whole. The array's axes are `[z, y, x]`, or `[c, z, y, x]`.
 */

import { DataEncoding } from "#src/datasource/precomputed/base.js";
import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
  CodecChainSpec,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import {
  parseCodecChainSpec,
  registerCodec,
} from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyEnumString,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

const NAME = "refkv.precomputed";

export type Encoding =
  | "raw"
  | "jpeg"
  | "png"
  | "compressed_segmentation"
  | "compresso"
  | "crackle"
  | "jxl";

// refkv's layout also presents fpzip, zfpc and kempressed, which have no decoder
// here.
const ENCODINGS: readonly string[] = [
  "raw",
  "jpeg",
  "png",
  "compressed_segmentation",
  "compresso",
  "crackle",
  "jxl",
];

const MEMBERS = new Set([
  "encoding",
  "size",
  "chunk_size",
  "compressed_segmentation_block_size",
  "sharding",
]);
const SHARDING_MEMBERS = new Set([
  "preshift_bits",
  "minishard_bits",
  "minishard_index_encoding",
  "data_encoding",
]);

export interface ChunkConfiguration {
  encoding: Encoding;
  /** The volume's size in voxels, x, y, z. */
  size: number[];
  /** A chunk's size in voxels, x, y, z. */
  chunkSize: number[];
  /** The volume's size in chunks, x, y, z. */
  grid: number[];
  blockSize: number[] | undefined;
  /** What fills a chunk past the volume's end. */
  fillValue: number | bigint;
}

export interface ShardConfiguration extends ChunkConfiguration {
  /** The chunks a Zarr chunk holds, in the array's order. */
  subChunkShape: number[];
  subChunkGridShape: number[];
  subChunkCodecs: CodecChainSpec;
  preshiftBits: number;
  minishardBits: number;
  minishardIndexEncoding: DataEncoding;
  dataEncoding: DataEncoding;
}

export type Configuration = ChunkConfiguration | ShardConfiguration;

function verifyOnlyMembers(
  obj: Record<string, unknown>,
  members: Set<string>,
  what: string,
) {
  for (const key of Object.keys(obj)) {
    if (!members.has(key)) {
      throw new Error(`${NAME}: unknown ${what} member ${JSON.stringify(key)}`);
    }
  }
}

function verifyInts3(value: unknown, what: string, max: number) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${NAME}: ${what} is not 3 integers`);
  }
  return value.map((v) => {
    const n = verifyInt(v);
    if (n < 1 || n > max) {
      throw new Error(`${NAME}: ${what} has ${n}, not 1 to ${max}`);
    }
    return n;
  });
}

function verifyBits(obj: unknown, name: string, max: number) {
  return verifyObjectProperty(obj as any, name, (value) => {
    const n = verifyInt(value);
    if (n < 0 || n > max) {
      throw new Error(`${NAME}: ${name} ${n} is not 0 to ${max}`);
    }
    return n;
  });
}

// What [refkv's layout](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/precomputed.md#33-scales-that-are-not-presented)
// leaves an array of each encoding, checked again here since an array can be
// copied out of its hierarchy.
function checkEncoding(
  encoding: Encoding,
  dataType: DataType,
  channels: number,
  blockSize: number[] | undefined,
) {
  const type = DataType[dataType].toLowerCase();
  if (encoding === "jpeg") {
    if (dataType !== DataType.UINT8 || (channels !== 1 && channels !== 3)) {
      throw new Error(
        `${NAME}: jpeg holds uint8 in 1 or 3 channels, not ${type} in ${channels}`,
      );
    }
  } else if (encoding === "png") {
    if (
      (dataType !== DataType.UINT8 && dataType !== DataType.UINT16) ||
      channels > 4
    ) {
      throw new Error(
        `${NAME}: png holds uint8 or uint16 in at most 4 channels, not ${type} in ${channels}`,
      );
    }
  } else if (encoding === "compressed_segmentation") {
    if (dataType !== DataType.UINT32 && dataType !== DataType.UINT64) {
      throw new Error(
        `${NAME}: compressed_segmentation holds uint32 or uint64, not ${type}`,
      );
    }
    if (blockSize === undefined) {
      throw new Error(
        `${NAME}: compressed_segmentation needs compressed_segmentation_block_size`,
      );
    }
  } else if (encoding === "compresso" || encoding === "crackle") {
    if (
      (dataType !== DataType.UINT8 &&
        dataType !== DataType.UINT16 &&
        dataType !== DataType.UINT32 &&
        dataType !== DataType.UINT64) ||
      channels !== 1
    ) {
      throw new Error(
        `${NAME}: ${encoding} holds uint8 to uint64 in 1 channel, not ${type} in ${channels}`,
      );
    }
  } else if (encoding === "jxl") {
    if (dataType !== DataType.UINT8 || channels !== 1) {
      throw new Error(
        `${NAME}: jxl holds uint8 in 1 channel, not ${type} in ${channels}`,
      );
    }
  }
}

function isPowerOf2(n: number) {
  return Number.isInteger(Math.log2(n));
}

registerCodec({
  name: NAME,
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; shardingInfo?: any } {
    const obj = verifyObject(configuration);
    verifyOnlyMembers(obj, MEMBERS, "configuration");
    const encoding = verifyObjectProperty(obj, "encoding", (value) => {
      const encoding = verifyString(value);
      if (!ENCODINGS.includes(encoding)) {
        throw new Error(
          `${NAME}: the encoding ${JSON.stringify(encoding)} has no decoder`,
        );
      }
      return encoding as Encoding;
    });
    const size = verifyObjectProperty(obj, "size", (value) =>
      verifyInts3(value, "size", Number.MAX_SAFE_INTEGER),
    );
    const chunkSize = verifyObjectProperty(obj, "chunk_size", (value) =>
      verifyInts3(value, "chunk_size", 2 ** 32 - 1),
    );
    const blockSize = verifyOptionalObjectProperty(
      obj,
      "compressed_segmentation_block_size",
      (value) =>
        verifyInts3(value, "compressed_segmentation_block_size", 2 ** 32 - 1),
    );
    const { dataType, chunkShape, fillValue = 0 } = decodedArrayInfo;
    const rank = chunkShape.length;
    if (rank !== 3 && rank !== 4) {
      throw new Error(`${NAME}: the array has ${rank} dimensions, not 3 or 4`);
    }
    const channels = rank === 4 ? chunkShape[0] : 1;
    checkEncoding(encoding, dataType, channels, blockSize);
    const grid = size.map((s, i) => Math.ceil(s / chunkSize[i]));
    if (grid.some((g) => g >= 2 ** 32)) {
      throw new Error(`${NAME}: the chunk grid is 2^32 chunks along an axis`);
    }
    const chunk: ChunkConfiguration = {
      encoding,
      size,
      chunkSize,
      grid,
      blockSize,
      fillValue,
    };
    // The Zarr chunk's size in chunks, z, y, x.
    const box = [2, 1, 0].map((axis, i) => {
      const k = chunkShape[rank - 3 + i] / chunkSize[axis];
      if (!Number.isInteger(k)) {
        throw new Error(
          `${NAME}: a chunk shape of ${JSON.stringify(chunkShape)} does not ` +
            `hold whole chunks of ${JSON.stringify(chunkSize)} (x, y, z)`,
        );
      }
      return k;
    });
    const sharding = verifyOptionalObjectProperty(
      obj,
      "sharding",
      verifyObject,
    );
    if (sharding === undefined) {
      if (box.some((k) => k !== 1)) {
        throw new Error(
          `${NAME}: an unsharded chunk shape of ${JSON.stringify(chunkShape)} ` +
            `is not one chunk of ${JSON.stringify(chunkSize)} (x, y, z)`,
        );
      }
      return { configuration: chunk };
    }
    verifyOnlyMembers(sharding, SHARDING_MEMBERS, "sharding");
    if (!box.every(isPowerOf2)) {
      throw new Error(
        `${NAME}: a shard's box of ${box.join(" x ")} chunks (z, y, x) is ` +
          "not a power of 2 along each axis",
      );
    }
    const subChunkShape = Array.from(chunkShape);
    subChunkShape.splice(rank - 3, 3, ...chunkSize.slice().reverse());
    const subChunkGridShape = chunkShape.map((n, i) => n / subChunkShape[i]);
    const unsharded = { ...obj };
    delete unsharded.sharding;
    const subChunkCodecs = parseCodecChainSpec(
      [{ name: NAME, configuration: unsharded }],
      { dataType, chunkShape: subChunkShape, fillValue },
    );
    const encodingProperty = (name: string) =>
      verifyObjectProperty(sharding, name, (value) =>
        verifyEnumString(value, DataEncoding),
      );
    const shard: ShardConfiguration = {
      ...chunk,
      subChunkShape,
      subChunkGridShape,
      subChunkCodecs,
      preshiftBits: verifyBits(sharding, "preshift_bits", 64),
      minishardBits: verifyBits(sharding, "minishard_bits", 32),
      minishardIndexEncoding: encodingProperty("minishard_index_encoding"),
      dataEncoding: encodingProperty("data_encoding"),
    };
    return {
      configuration: shard,
      shardingInfo: { subChunkShape, subChunkGridShape, subChunkCodecs },
    };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    if ("subChunkCodecs" in configuration) {
      return configuration.subChunkCodecs.layoutInfo[0];
    }
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
