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
 * @file Decodes `refkv.precomputed` chunks (see resolve.ts) with Neuroglancer's
 * own decoders of the precomputed encodings and reader of its sharded format.
 *
 * A shard is read through its own indexes: one chunk takes the 16 bytes of the
 * shard index that locate its minishard's index, that index, and the chunk.
 * What the sharded key-value store gives for a chunk has the layout of an
 * unsharded Zarr chunk, its position and then its bytes, so that the array ->
 * bytes decoder below reads both.
 *
 * Where this reader cannot give the values refkv's Python decoder does, it
 * refuses ([decoding](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/precomputed.md#62-decoding),
 * [content codings](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/precomputed.md#63-content-codings)):
 *
 * - bytes that are not their encoding, gzip or Zstandard, since there is no
 *   brotli decoder here. A browser undoes a `Content-Encoding` itself, but
 *   the vzip kvstore refuses such a response (src/kvstore/vzip/http.ts), as
 *   refkv's reader rule for `fetch` says, so these are bytes stored coded
 *   without the header.
 * - a JPEG of other than 8 bits, or with subsampled chroma, which jpgjs
 *   upsamples more simply than libjpeg does, by up to 10 levels in refkv's
 *   fixture. A JPEG without subsampling is not refused: it differs from
 *   libjpeg's by at most 1 level, the rounding of the inverse DCT, in the 4
 *   BANC chunks compared, and Neuroglancer's precomputed data source shows the
 *   same values.
 * - a PNG of several 16-bit channels, whose samples `decompressPng` does not
 *   separate.
 * - a compressed_segmentation stream whose offsets run past its end, which
 *   the decoder would read as zeros.
 * - a compresso or crackle stream whose header gives another shape or voxel
 *   width than the chunk's, and a JPEG XL image of another size.
 *
 * A lossy JPEG XL may differ from libjxl's by 1 level, jxl-oxide's rounding, in
 * refkv's fixture. One thing is not refused: a JPEG XL of 3 samples where the
 * chunk holds 1, which `decompressJxl` cuts to the chunk's bytes, as it does for
 * the precomputed data source, since its module does not say how many samples
 * an image has.
 */

import { decodeCompresso } from "#src/async_computation/decode_compresso_request.js";
import { decodeCrackle } from "#src/async_computation/decode_crackle_request.js";
import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { decodeJxl } from "#src/async_computation/decode_jxl_request.js";
import { decodePng } from "#src/async_computation/decode_png_request.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { SimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import {
  decodeFileHandle,
  findMinishardEntry,
  readMinishardIndex,
} from "#src/datasource/precomputed/sharded.js";
import type { ShardingKey } from "#src/datasource/zarr/codec/decode.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type {
  ChunkConfiguration,
  ShardConfiguration,
} from "#src/datasource/zarr/codec/refkv_precomputed/resolve.js";
import {
  FileByteRangeHandle,
  handleByteRangeRequestFromUint8Array,
} from "#src/kvstore/byte_range/file_handle.js";
import type {
  ByteRange,
  DriverReadOptions,
  FileHandle,
  ReadableKvStore,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle, readFileHandle } from "#src/kvstore/index.js";
import { decodeChannels as decodeChannelsUint32 } from "#src/sliceview/compressed_segmentation/decode_uint32.js";
import { decodeChannels as decodeChannelsUint64 } from "#src/sliceview/compressed_segmentation/decode_uint64.js";
import type { TypedArray } from "#src/util/array.js";
import {
  DATA_TYPE_ARRAY_CONSTRUCTOR,
  DATA_TYPE_BYTES,
  DataType,
  makeDataTypeArrayView,
} from "#src/util/data_type.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { convertEndian, Endianness } from "#src/util/endian.js";
import { decodeGzip } from "#src/util/gzip.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { encodeZIndexCompressed3d } from "#src/util/zorder.js";

const NAME = "refkv.precomputed";

// The position: x, y and z on the chunk grid, each a little-endian uint32.
const POSITION_BYTES = 12;

function readPosition(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return [0, 4, 8].map((offset) => view.getUint32(offset, true));
}

/** `data` in a buffer of its own: the decoders below assume no byte offset. */
function ownBuffer(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : data.slice();
}

function startsWith(data: Uint8Array, ...magic: number[]) {
  return magic.every((byte, i) => data[i] === byte);
}

/**
 * A chunk object's bytes without the content coding they may be stored in,
 * [found from the bytes](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/precomputed.md#63-content-codings).
 */
export async function removeContentCoding(
  data: Uint8Array<ArrayBuffer>,
  encoding: ChunkConfiguration["encoding"],
  rawByteLengths: number[],
  channels: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  switch (encoding) {
    case "raw":
      if (rawByteLengths.includes(data.length)) return data;
      break;
    case "jpeg":
      if (startsWith(data, 0xff, 0xd8)) return data;
      break;
    case "png":
      if (startsWith(data, 0x89, 0x50, 0x4e, 0x47)) return data;
      break;
    case "compressed_segmentation":
      if (
        data.length >= 4 &&
        new DataView(data.buffer, data.byteOffset).getUint32(0, true) ===
          channels
      ) {
        return data;
      }
      break;
    case "compresso":
      if (startsWith(data, 0x63, 0x70, 0x73, 0x6f)) return data;
      break;
    case "crackle":
      if (startsWith(data, 0x63, 0x72, 0x6b, 0x6c)) return data;
      break;
    case "jxl":
      if (
        startsWith(data, 0xff, 0x0a) ||
        startsWith(
          data,
          0,
          0,
          0,
          0x0c,
          0x4a,
          0x58,
          0x4c,
          0x20,
          0x0d,
          0x0a,
          0x87,
          0x0a,
        )
      ) {
        return data;
      }
      break;
  }
  if (startsWith(data, 0x1f, 0x8b)) {
    return new Uint8Array(await decodeGzip(data, "gzip", signal));
  }
  if (startsWith(data, 0x28, 0xb5, 0x2f, 0xfd)) {
    return ownBuffer(
      await requestAsyncComputation(decodeZstd, signal, [data.buffer], data),
    );
  }
  throw new Error(
    `${NAME}: a chunk of ${data.length} bytes is not ${encoding}, gzip or ` +
      "zstd, and this reader does not decode brotli",
  );
}

/**
 * Refuses a JPEG that jpgjs would decode to other values than libjpeg's: of
 * another precision, or with subsampled chroma. Other streams it cannot parse
 * make it throw on its own.
 */
export function checkJpegDecodesExactly(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];
    if (marker === 0xff) {
      ++offset;
      continue;
    }
    // Start of frame: every 0xCn but DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 10 > data.length) break;
      const precision = data[offset + 4];
      if (precision !== 8) {
        throw new Error(
          `${NAME}: a JPEG of ${precision} bits is not supported`,
        );
      }
      const numComponents = data[offset + 9];
      if (numComponents > 1) {
        if (offset + 10 + 3 * numComponents > data.length) break;
        const sampling = data[offset + 11];
        for (let i = 1; i < numComponents; ++i) {
          if (data[offset + 11 + 3 * i] !== sampling) {
            throw new Error(
              `${NAME}: a JPEG with subsampled chroma is not supported: this ` +
                "decoder upsamples it to other values than libjpeg's",
            );
          }
        }
      }
      return;
    }
    if (marker === 0xda) break;
    offset += 2 + view.getUint16(offset + 2, false);
  }
  throw new Error(`${NAME}: a JPEG has no frame header`);
}

/**
 * Refuses a compressed_segmentation stream with an offset past its end, which
 * `decodeChannels` would read as zeros (the format is in
 * src/sliceview/compressed_segmentation/README.md).
 */
export function checkCompressedSegmentation(
  words: Uint32Array,
  shape: number[],
  blockSize: number[],
  uint32sPerElement: number,
) {
  const fail = (what: string): never => {
    throw new Error(`${NAME}: compressed_segmentation: ${what}`);
  };
  const [sx, sy, sz, channels] = shape;
  const [bx, by, bz] = blockSize;
  const numBlocks =
    Math.ceil(sx / bx) * Math.ceil(sy / by) * Math.ceil(sz / bz);
  const blockVoxels = bx * by * bz;
  if (words.length < channels) fail("shorter than its channel offsets");
  for (let channel = 0; channel < channels; ++channel) {
    const base = words[channel];
    if (base + 2 * numBlocks > words.length) {
      fail("a block header past the stream's end");
    }
    for (let block = 0; block < numBlocks; ++block) {
      const header = base + 2 * block;
      const table = base + (words[header] & 0xffffff);
      const bits = words[header] >>> 24;
      const values = base + words[header + 1];
      if (![0, 1, 2, 4, 8, 16, 32].includes(bits)) {
        fail(`${bits} bits a voxel`);
      }
      let maxIndex = 0;
      if (bits !== 0) {
        if (values + Math.ceil((blockVoxels * bits) / 32) > words.length) {
          fail("block values past the stream's end");
        }
        const mask = 2 ** bits - 1;
        for (let i = 0; i < blockVoxels; ++i) {
          const bit = i * bits;
          const word = words[values + Math.floor(bit / 32)];
          const index = (word >>> bit % 32) & mask;
          if (index >>> 0 > maxIndex) maxIndex = index >>> 0;
        }
      }
      if (table + (maxIndex + 1) * uint32sPerElement > words.length) {
        fail("a block's table past the stream's end");
      }
    }
  }
}

/**
 * Refuses a compresso or crackle stream whose header does not give the chunk's
 * shape and voxel width, which the decoders would give as bytes of another
 * chunk. The decoders check the rest of the header.
 */
export function checkLabelStream(
  data: Uint8Array,
  encoding: "compresso" | "crackle",
  [x, y, z]: number[],
  bytesPerElement: number,
) {
  const headerBytes = encoding === "compresso" ? 12 : 19;
  if (data.length < headerBytes) {
    throw new Error(
      `${NAME}: a ${encoding} stream of ${data.length} bytes has no header`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [width, sx, sy, sz] =
    encoding === "compresso"
      ? [
          data[5],
          view.getUint16(6, true),
          view.getUint16(8, true),
          view.getUint16(10, true),
        ]
      : [
          2 ** (view.getUint16(5, true) & 3),
          view.getUint32(7, true),
          view.getUint32(11, true),
          view.getUint32(15, true),
        ];
  if (sx !== x || sy !== y || sz !== z || width !== bytesPerElement) {
    throw new Error(
      `${NAME}: a ${encoding} stream holds ${sx} x ${sy} x ${sz} voxels of ` +
        `${width} bytes, not ${x} x ${y} x ${z} of ${bytesPerElement}`,
    );
  }
}

/**
 * The values of a chunk of `[x, y, z]` voxels in `channels` channels, x
 * fastest and the channel slowest, at their own size: `[x, y, z]`, or the
 * chunk size for a raw chunk a writer padded.
 */
async function decodeChunk(
  configuration: ChunkConfiguration,
  dataType: DataType,
  [x, y, z]: number[],
  channels: number,
  stored: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<{ values: TypedArray<ArrayBuffer>; size: number[] }> {
  const { encoding, chunkSize, blockSize } = configuration;
  const [cx, cy, cz] = chunkSize;
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const clippedBytes = channels * z * y * x * bytesPerElement;
  const wholeBytes = channels * cz * cy * cx * bytesPerElement;
  const data = await removeContentCoding(
    stored,
    encoding,
    [clippedBytes, wholeBytes],
    channels,
    signal,
  );
  const view = (bytes: Uint8Array<ArrayBuffer>) =>
    makeDataTypeArrayView(
      dataType,
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ) as TypedArray<ArrayBuffer>;
  switch (encoding) {
    case "raw": {
      if (data.length !== clippedBytes && data.length !== wholeBytes) {
        throw new Error(
          `${NAME}: a raw chunk is ${data.length} bytes, not ${clippedBytes}`,
        );
      }
      const values = view(data);
      convertEndian(values, Endianness.LITTLE, bytesPerElement);
      return {
        values,
        size: data.length === clippedBytes ? [x, y, z] : [cx, cy, cz],
      };
    }
    case "jpeg": {
      checkJpegDecodesExactly(data);
      const { uint8Array } = await requestAsyncComputation(
        decodeJpeg,
        signal,
        [data.buffer],
        data,
        /*width=*/ x,
        /*height=*/ y * z,
        /*area=*/ undefined,
        /*numComponents=*/ channels,
        /*convertToGrayscale=*/ false,
      );
      return { values: view(uint8Array), size: [x, y, z] };
    }
    case "png": {
      if (bytesPerElement !== 1 && channels !== 1) {
        throw new Error(
          `${NAME}: a PNG of ${channels} channels of 16 bits is not supported`,
        );
      }
      const { uint8Array } = await requestAsyncComputation(
        decodePng,
        signal,
        [data.buffer],
        data,
        /*width=*/ x,
        /*height=*/ y * z,
        /*area=*/ undefined,
        /*numComponents=*/ channels,
        /*bytesPerPixel=*/ bytesPerElement,
        /*convertToGrayscale=*/ false,
      );
      return { values: view(uint8Array), size: [x, y, z] };
    }
    case "jxl": {
      const { uint8Array, width, height } = await requestAsyncComputation(
        decodeJxl,
        signal,
        [data.buffer],
        data,
        /*area=*/ x * y * z,
        /*numComponents=*/ channels,
        /*bytesPerPixel=*/ bytesPerElement,
      );
      if (width !== x || height !== y * z) {
        throw new Error(
          `${NAME}: a JPEG XL of ${width} x ${height} is not one of ${x} x ${y * z}`,
        );
      }
      return { values: view(uint8Array), size: [x, y, z] };
    }
    case "compresso":
    case "crackle": {
      checkLabelStream(data, encoding, [x, y, z], bytesPerElement);
      const decoded = await requestAsyncComputation(
        encoding === "compresso" ? decodeCompresso : decodeCrackle,
        signal,
        [data.buffer],
        data,
      );
      const values = view(decoded);
      convertEndian(values, Endianness.LITTLE, bytesPerElement);
      return { values, size: [x, y, z] };
    }
    case "compressed_segmentation": {
      if (data.length % 4 !== 0) {
        throw new Error(
          `${NAME}: compressed_segmentation of ${data.length} bytes is not ` +
            "a whole number of 32-bit words",
        );
      }
      const words = new Uint32Array(
        data.buffer,
        data.byteOffset,
        data.length / 4,
      );
      const shape = [x, y, z, channels];
      const uint64 = dataType === DataType.UINT64;
      checkCompressedSegmentation(words, shape, blockSize!, uint64 ? 2 : 1);
      const n = channels * z * y * x;
      const values = uint64
        ? decodeChannelsUint64(
            new BigUint64Array(n),
            words,
            0,
            shape,
            blockSize!,
          )
        : decodeChannelsUint32(new Uint32Array(n), words, 0, shape, blockSize!);
      return { values: values as TypedArray<ArrayBuffer>, size: [x, y, z] };
    }
  }
}

/**
 * The chunk's values at its whole size, the fill value past the `[x, y, z]`
 * voxels the volume holds. `size` is the size of `values`.
 */
export function fillChunk(
  values: TypedArray<ArrayBuffer>,
  size: number[],
  [x, y, z]: number[],
  chunkSize: number[],
  channels: number,
  dataType: DataType,
  fillValue: number | bigint,
): TypedArray<ArrayBuffer> {
  const [cx, cy, cz] = chunkSize;
  if (x === cx && y === cy && z === cz) return values;
  const output = new (DATA_TYPE_ARRAY_CONSTRUCTOR[dataType] as any)(
    channels * cz * cy * cx,
  );
  if (fillValue !== 0 && fillValue !== 0n) output.fill(fillValue);
  const [sx, sy, sz] = size;
  for (let c = 0; c < channels; ++c) {
    for (let iz = 0; iz < z; ++iz) {
      for (let iy = 0; iy < y; ++iy) {
        const from = ((c * sz + iz) * sy + iy) * sx;
        output.set(
          values.subarray(from, from + x),
          ((c * cz + iz) * cy + iy) * cx,
        );
      }
    }
  }
  return output;
}

registerCodec({
  name: NAME,
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: ChunkConfiguration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (encoded.length < POSITION_BYTES) {
      throw new Error(
        `${NAME}: a chunk of ${encoded.length} bytes has no position`,
      );
    }
    const { chunkShape, dataType } = decodedArrayInfo;
    const { size, chunkSize, grid, fillValue } = configuration;
    const channels = chunkShape.length === 4 ? chunkShape[0] : 1;
    const position = readPosition(encoded);
    if (position.some((p, i) => p >= grid[i])) {
      throw new Error(
        `${NAME}: a chunk at ${position} is past the grid of ${grid} chunks`,
      );
    }
    const clipped = position.map((p, i) =>
      Math.min(chunkSize[i], size[i] - p * chunkSize[i]),
    );
    const { values, size: valuesSize } = await decodeChunk(
      configuration,
      dataType,
      clipped,
      channels,
      ownBuffer(encoded.subarray(POSITION_BYTES)),
      signal,
    );
    return fillChunk(
      values,
      valuesSize,
      clipped,
      chunkSize,
      channels,
      dataType,
      fillValue,
    );
  },
});

/** A shard object, without the position before it in the Zarr chunk. */
class ShardObjectHandle implements FileHandle {
  constructor(private zarrChunk: FileHandle) {}

  async stat(options: StatOptions): Promise<StatResponse | undefined> {
    const stat = await this.zarrChunk.stat(options);
    if (stat?.totalSize === undefined) return stat;
    return { totalSize: stat.totalSize - POSITION_BYTES };
  }

  async read(options: DriverReadOptions): Promise<ReadResponse | undefined> {
    const { byteRange } = options;
    if (byteRange === undefined || "suffixLength" in byteRange) {
      throw new Error(`${NAME}: a shard is read by offset and length`);
    }
    const response = await readFileHandle(this.zarrChunk, {
      ...options,
      byteRange: {
        offset: POSITION_BYTES + byteRange.offset,
        length: byteRange.length,
      },
      strictByteRange: true,
    });
    if (response === undefined) return undefined;
    const { totalSize } = response;
    return {
      ...response,
      offset: byteRange.offset,
      totalSize:
        totalSize === undefined ? undefined : totalSize - POSITION_BYTES,
    };
  }

  getUrl() {
    return this.zarrChunk.getUrl();
  }
}

type MinishardKey<BaseKey> = { base: BaseKey; minishard: bigint };

/** The bits of a chunk id along an axis of `n` chunks: `ceil(log2(n))`. */
function idBits(n: number) {
  return n === 1 ? 0 : 32 - Math.clz32(n - 1);
}

class PrecomputedShardedKvStore<BaseKey>
  extends RefCounted
  implements ReadableKvStore<ShardingKey<BaseKey>>
{
  private positionCache: Owned<SimpleAsyncCache<BaseKey, number[] | undefined>>;
  private minishardIndexCache: Owned<
    SimpleAsyncCache<MinishardKey<BaseKey>, BigUint64Array | undefined>
  >;

  constructor(
    private configuration: ShardConfiguration,
    chunkManager: ChunkManager,
    private base: ReadableKvStore<BaseKey>,
  ) {
    super();
    const { minishardBits, minishardIndexEncoding } = configuration;
    this.positionCache = this.registerDisposer(
      new SimpleAsyncCache(chunkManager.addRef(), {
        get: async (key: BaseKey, progressOptions: ProgressOptions) => {
          const position = await this.readShardPosition(key, progressOptions);
          return { size: POSITION_BYTES, data: position };
        },
      }),
    );
    this.minishardIndexCache = this.registerDisposer(
      new SimpleAsyncCache(chunkManager.addRef(), {
        encodeKey: ({ base, minishard }: MinishardKey<BaseKey>) =>
          `${JSON.stringify(base)}:${minishard}`,
        get: async (
          { base, minishard }: MinishardKey<BaseKey>,
          progressOptions: ProgressOptions,
        ) => {
          const data = await readMinishardIndex(
            this.shardHandle(base),
            minishard,
            { minishardBits, minishardIndexEncoding },
            progressOptions,
          );
          return { size: data?.byteLength ?? 0, data };
        },
      }),
    );
  }

  private shardHandle(base: BaseKey) {
    return new ShardObjectHandle(new KvStoreFileHandle(this.base, base));
  }

  private async readShardPosition(
    key: BaseKey,
    options: Partial<ProgressOptions>,
  ) {
    const response = await readFileHandle(
      new KvStoreFileHandle(this.base, key),
      {
        ...options,
        byteRange: { offset: 0, length: POSITION_BYTES },
        strictByteRange: true,
      },
    );
    if (response === undefined) return undefined;
    const position = readPosition(
      new Uint8Array(await response.response.arrayBuffer()),
    );
    // A chunk's id is computed from its position, and a position that is not
    // the shard's own would read another chunk's values.
    const { subChunkGridShape, grid } = this.configuration;
    const rank = subChunkGridShape.length;
    if (
      position.some(
        (p, i) => p % subChunkGridShape[rank - 1 - i] !== 0 || p >= grid[i],
      )
    ) {
      throw new Error(
        `${NAME}: the shard at ${this.base.getUrl(key)} has the position ` +
          `${position}, which is not the start of a box within the grid`,
      );
    }
    return position;
  }

  /** The chunk's position on the grid and its bytes' range in the shard. */
  private async findChunk(
    key: ShardingKey<BaseKey>,
    options: Partial<ProgressOptions>,
  ): Promise<{ position: number[]; range: ByteRange } | undefined> {
    const { grid, preshiftBits, minishardBits } = this.configuration;
    const origin = await this.positionCache.get(key.base, options);
    if (origin === undefined) return undefined;
    const rank = key.subChunk.length;
    const position = origin.map((p, i) => p + key.subChunk[rank - 1 - i]);
    // A box may run past the grid, where it holds no chunk.
    if (position.some((p, i) => p >= grid[i])) return undefined;
    const id = encodeZIndexCompressed3d(
      idBits(grid[0]),
      idBits(grid[1]),
      idBits(grid[2]),
      position[0],
      position[1],
      position[2],
    );
    const minishard =
      (id >> BigInt(preshiftBits)) & ((1n << BigInt(minishardBits)) - 1n);
    const index = await this.minishardIndexCache.get(
      { base: key.base, minishard },
      options,
    );
    if (index === undefined) return undefined;
    const range = findMinishardEntry(index, id);
    return range === undefined ? undefined : { position, range };
  }

  async stat(
    key: ShardingKey<BaseKey>,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const found = await this.findChunk(key, options);
    return found === undefined ? undefined : { totalSize: undefined };
  }

  async read(
    key: ShardingKey<BaseKey>,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const found = await this.findChunk(key, options);
    if (found === undefined) return undefined;
    const { position, range } = found;
    const response = await decodeFileHandle(
      new FileByteRangeHandle(this.shardHandle(key.base), range),
      this.configuration.dataEncoding,
    ).read({ signal: options.signal });
    const chunk = new Uint8Array(await response!.response.arrayBuffer());
    const value = new Uint8Array(POSITION_BYTES + chunk.length);
    const view = new DataView(value.buffer);
    position.forEach((p, i) => view.setUint32(i * 4, p, true));
    value.set(chunk, POSITION_BYTES);
    return handleByteRangeRequestFromUint8Array(value, options.byteRange);
  }

  getUrl(key: ShardingKey<BaseKey>): string {
    return `chunk ${JSON.stringify(key.subChunk)} of shard ${this.base.getUrl(key.base)}`;
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }
}

registerCodec({
  name: NAME,
  kind: CodecKind.arrayToBytes,
  getShardedKvStore<BaseKey>(
    configuration: ShardConfiguration,
    chunkManager: ChunkManager,
    base: ReadableKvStore<BaseKey>,
  ) {
    return new PrecomputedShardedKvStore(configuration, chunkManager, base);
  },
});
