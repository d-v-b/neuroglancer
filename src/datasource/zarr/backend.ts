/**
 * @license
 * Copyright 2020 Google Inc.
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

import "#src/datasource/zarr/codec/blosc/decode.js";
import "#src/datasource/zarr/codec/zstd/decode.js";
import "#src/datasource/zarr/codec/bytes/decode.js";
import "#src/datasource/zarr/codec/crc32c/decode.js";

import { WithParameters } from "#src/chunk_manager/backend.js";
import { VolumeChunkSourceParameters } from "#src/datasource/zarr/base.js";
import {
  applySharding,
  decodeArray,
} from "#src/datasource/zarr/codec/decode.js";
import "#src/datasource/zarr/codec/gzip/decode.js";
import "#src/datasource/zarr/codec/jpeg/decode.js";
import "#src/datasource/zarr/codec/jpeg2k/decode.js";
import "#src/datasource/zarr/codec/jpegxr/decode.js";
import "#src/datasource/zarr/codec/ljpeg/decode.js";
import "#src/datasource/zarr/codec/lzw/decode.js";
import "#src/datasource/zarr/codec/n5_default/decode.js";
import "#src/datasource/zarr/codec/numcodecs_shuffle/decode.js";
import "#src/datasource/zarr/codec/refkv_fits_tiles/decode.js";
import "#src/datasource/zarr/codec/refkv_stream/decode.js";
import "#src/datasource/zarr/codec/sharding_indexed/decode.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import type { ChunkExtent } from "#src/datasource/zarr/metadata/chunk_grid.js";
import {
  assembleChunk,
  RectilinearDimension,
  regularDimension,
} from "#src/datasource/zarr/metadata/chunk_grid.js";
import { ChunkKeyEncoding } from "#src/datasource/zarr/metadata/index.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import type { TypedArray } from "#src/util/array.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import { registerSharedObject } from "#src/worker_rpc.js";

@registerSharedObject()
export class ZarrVolumeChunkSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  VolumeChunkSourceParameters,
) {
  private chunkKvStore = applySharding(
    this.chunkManager,
    this.parameters.metadata.codecs,
    this.sharedKvStoreContext.kvStoreContext.getKvStore(this.parameters.url),
  );

  // Whether Neuroglancer's chunks are the zarr read chunks (the common case),
  // or span several of them along channel dimensions (see
  // `spanChannelDimensions`), and are assembled.
  private spansReadChunks = (() => {
    const { rank, chunkDataSize } = this.spec;
    const { readChunkShape, physicalToLogicalDimension } =
      this.parameters.metadata.codecs.layoutInfo[0];
    for (let i = 0; i < rank; ++i) {
      const arrayDim = physicalToLogicalDimension[rank - 1 - i];
      if (chunkDataSize[i] !== readChunkShape[arrayDim]) return true;
    }
    return false;
  })();

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    if (this.parameters.metadata.chunkGrid !== undefined) {
      return this.downloadAssembled(
        chunk,
        signal,
        this.rectilinearDimensions!,
        (extents, arrayDims) =>
          this.readRectilinearChunk(extents, arrayDims, signal),
      );
    }
    if (this.spansReadChunks) {
      return this.downloadAssembled(
        chunk,
        signal,
        this.regularDimensions,
        (extents) => this.readRegularChunk(extents, signal),
      );
    }
    chunk.chunkDataSize = this.spec.chunkDataSize;
    const { parameters } = this;
    const { chunkGridPosition } = chunk;
    const { metadata } = parameters;
    const rank = this.spec.rank;
    const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
    const keyCoords = new Array<number>(rank);
    const { readChunkShape } = metadata.codecs.layoutInfo[0];
    const { chunkShape } = metadata;
    for (
      let fOrderPhysicalDim = 0;
      fOrderPhysicalDim < rank;
      ++fOrderPhysicalDim
    ) {
      const decodedDim =
        physicalToLogicalDimension[rank - 1 - fOrderPhysicalDim];
      keyCoords[decodedDim] = Math.floor(
        (chunkGridPosition[fOrderPhysicalDim] * readChunkShape[decodedDim]) /
          chunkShape[decodedDim],
      );
    }
    const baseKey = this.getBaseKey(keyCoords);
    const { chunkKvStore } = this;
    const response = await chunkKvStore.kvStore.read(
      chunkKvStore.getChunkKey(chunkGridPosition, baseKey),
      { signal },
    );
    if (response !== undefined) {
      const decoded = await decodeArray(
        chunkKvStore.decodeCodecs,
        new Uint8Array(await response.response.arrayBuffer()),
        signal,
      );
      await postProcessRawData(chunk, signal, decoded);
    }
  }

  private getBaseKey(keyCoords: readonly number[]) {
    const { metadata } = this.parameters;
    let baseKey = "";
    let sep: string;
    if (metadata.chunkKeyEncoding === ChunkKeyEncoding.DEFAULT) {
      baseKey += "c";
      sep = metadata.dimensionSeparator;
    } else {
      sep = "";
      if (keyCoords.length === 0) {
        baseKey += "0";
      }
    }
    for (const coord of keyCoords) {
      baseKey += `${sep}${coord}`;
      sep = metadata.dimensionSeparator;
    }
    return baseKey;
  }

  // Rectilinear chunk grids (see `metadata/chunk_grid.ts`).

  private rectilinearDimensions = this.parameters.metadata.chunkGrid?.runs.map(
    (runs) => new RectilinearDimension(runs),
  );

  private codecsByChunkShape = new Map<string, CodecChainSpec>();

  // The codecs resolved for a zarr chunk of shape `chunkShape`.
  private getCodecsForChunkShape(chunkShape: number[]): CodecChainSpec {
    const { metadata } = this.parameters;
    const key = chunkShape.join();
    let codecs = this.codecsByChunkShape.get(key);
    if (codecs === undefined) {
      codecs = parseCodecChainSpec(metadata.chunkGrid!.codecs, {
        dataType: metadata.dataType,
        chunkShape,
      });
      this.codecsByChunkShape.set(key, codecs);
    }
    return codecs;
  }

  // Reads and decodes the zarr chunk with the extents `extents` (by chunk
  // dimension, Fortran order; chunk dimension `i` is array dimension
  // `arrayDims[i]`), or returns undefined if it is missing.
  private async readRectilinearChunk(
    extents: ChunkExtent[],
    arrayDims: number[],
    signal: AbortSignal,
  ) {
    const rank = extents.length;
    const keyCoords = new Array<number>(rank);
    const chunkShape = new Array<number>(rank);
    for (let i = 0; i < rank; ++i) {
      keyCoords[arrayDims[i]] = extents[i].index;
      chunkShape[arrayDims[i]] = extents[i].length;
    }
    const { kvStore, getChunkKey } = this.chunkKvStore;
    const response = await kvStore.read(
      getChunkKey(keyCoords, this.getBaseKey(keyCoords)),
      { signal },
    );
    if (response === undefined) return undefined;
    const decoded = await decodeArray(
      this.getCodecsForChunkShape(chunkShape),
      new Uint8Array(await response.response.arrayBuffer()),
      signal,
    );
    return this.typedView(decoded);
  }

  private typedView(decoded: ArrayBufferView<ArrayBuffer>) {
    return makeDataTypeArrayView(
      this.parameters.metadata.dataType,
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    ) as TypedArray<ArrayBuffer>;
  }

  // The read chunks of a regular grid along each array dimension.
  private regularDimensions =
    this.parameters.metadata.codecs.layoutInfo[0].readChunkShape.map(
      (length, i) =>
        regularDimension(length, this.parameters.metadata.shape[i]),
    );

  // Reads and decodes the read chunk of a regular grid with the extents
  // `extents` (by chunk dimension, Fortran order), as `download` reads the
  // one at a chunk grid position, or returns undefined if it is missing.
  private async readRegularChunk(extents: ChunkExtent[], signal: AbortSignal) {
    const { metadata } = this.parameters;
    const rank = extents.length;
    const { physicalToLogicalDimension, readChunkShape } =
      metadata.codecs.layoutInfo[0];
    const { chunkShape } = metadata;
    const position = extents.map((e) => e.index);
    const keyCoords = new Array<number>(rank);
    for (let i = 0; i < rank; ++i) {
      const arrayDim = physicalToLogicalDimension[rank - 1 - i];
      keyCoords[arrayDim] = Math.floor(
        (position[i] * readChunkShape[arrayDim]) / chunkShape[arrayDim],
      );
    }
    const { kvStore, getChunkKey, decodeCodecs } = this.chunkKvStore;
    const response = await kvStore.read(
      getChunkKey(position, this.getBaseKey(keyCoords)),
      { signal },
    );
    if (response === undefined) return undefined;
    return this.typedView(
      await decodeArray(
        decodeCodecs,
        new Uint8Array(await response.response.arrayBuffer()),
        signal,
      ),
    );
  }

  // Downloads a chunk that is not one zarr chunk: it is assembled from the
  // zarr chunks it overlaps, found along each array dimension in
  // `dimensions` and read by `read` (see `assembleChunk`).
  private async downloadAssembled(
    chunk: VolumeChunk,
    signal: AbortSignal,
    dimensions: RectilinearDimension[],
    read: (
      extents: ChunkExtent[],
      arrayDims: number[],
    ) => Promise<TypedArray<ArrayBuffer> | undefined>,
  ) {
    const { metadata } = this.parameters;
    const { spec } = this;
    const { rank } = spec;
    const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
    const { chunkGridPosition } = chunk;
    // Chunk dimension `i` (Fortran order) is array dimension
    // `arrayDims[i]`; Neuroglancer's chunk covers [lower, upper) of it.
    const arrayDims = new Array<number>(rank);
    const lower = new Array<number>(rank);
    const upper = new Array<number>(rank);
    for (let i = 0; i < rank; ++i) {
      const arrayDim = physicalToLogicalDimension[rank - 1 - i];
      arrayDims[i] = arrayDim;
      lower[i] = chunkGridPosition[i] * spec.chunkDataSize[i];
      upper[i] = Math.min(
        lower[i] + spec.chunkDataSize[i],
        metadata.shape[arrayDim],
      );
    }
    const { dataType, fillValue } = metadata;
    const assembled = await assembleChunk(
      lower,
      upper,
      arrayDims.map((d) => dimensions[d]),
      (extents) => read(extents, arrayDims),
      (numElements) => {
        const output = makeDataTypeArrayView(
          dataType,
          new ArrayBuffer(numElements * DATA_TYPE_BYTES[dataType]),
        ) as TypedArray<ArrayBuffer>;
        if (fillValue !== 0 && fillValue !== 0n) {
          (output as any).fill(fillValue);
        }
        return output;
      },
    );
    if (assembled === undefined) return;
    const { data, size } = assembled;
    chunk.chunkDataSize = size.every((n, i) => n === spec.chunkDataSize[i])
      ? spec.chunkDataSize
      : size;
    await postProcessRawData(chunk, signal, data);
  }
}
