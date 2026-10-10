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
import "#src/datasource/zarr/codec/n5_default/decode.js";
import "#src/datasource/zarr/codec/numcodecs_shuffle/decode.js";
import "#src/datasource/zarr/codec/sharding_indexed/decode.js";
import "#src/datasource/zarr/codec/transpose/decode.js";
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import type { ChunkExtent } from "#src/datasource/zarr/metadata/chunk_grid.js";
import {
  copyBox,
  getCoveringChunks,
  RectilinearDimension,
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

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    if (this.parameters.metadata.chunkGrid !== undefined) {
      return this.downloadRectilinear(chunk, signal);
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

  // Reads and decodes the zarr chunk `keyCoords` of shape `chunkShape`
  // (both by array dimension), or returns undefined if it is missing.
  private async readRectilinearChunk(
    keyCoords: number[],
    chunkShape: number[],
    signal: AbortSignal,
  ) {
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
    return makeDataTypeArrayView(
      this.parameters.metadata.dataType,
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    ) as TypedArray<ArrayBuffer>;
  }

  private async downloadRectilinear(chunk: VolumeChunk, signal: AbortSignal) {
    const { metadata } = this.parameters;
    const { spec } = this;
    const { rank } = spec;
    const dimensions = this.rectilinearDimensions!;
    const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
    const { chunkGridPosition } = chunk;
    // Chunk dimension `i` (Fortran order) is array dimension
    // `arrayDims[i]`; Neuroglancer's chunk covers [lower, upper) of it.
    const arrayDims = new Array<number>(rank);
    const lower = new Array<number>(rank);
    const upper = new Array<number>(rank);
    // The zarr chunks covering [lower, upper), as {index, start, length}.
    const covering: ChunkExtent[][] = [];
    let single = true;
    for (let i = 0; i < rank; ++i) {
      const arrayDim = physicalToLogicalDimension[rank - 1 - i];
      arrayDims[i] = arrayDim;
      const lo = chunkGridPosition[i] * spec.chunkDataSize[i];
      const hi = Math.min(lo + spec.chunkDataSize[i], metadata.shape[arrayDim]);
      if (hi <= lo) return;
      lower[i] = lo;
      upper[i] = hi;
      const chunks = getCoveringChunks(dimensions[arrayDim], lo, hi);
      covering.push(chunks);
      if (chunks.length !== 1 || chunks[0].start !== lo) single = false;
    }

    // Visits every zarr chunk covering this chunk.
    const zarrChunks: ChunkExtent[][] = [];
    const visit = (i: number, current: ChunkExtent[]) => {
      if (i === rank) {
        zarrChunks.push(current.slice());
        return;
      }
      for (const c of covering[i]) {
        current[i] = c;
        visit(i + 1, current);
      }
    };
    visit(0, new Array(rank));

    const read = (chunks: ChunkExtent[]) => {
      const keyCoords = new Array<number>(rank);
      const chunkShape = new Array<number>(rank);
      for (let i = 0; i < rank; ++i) {
        keyCoords[arrayDims[i]] = chunks[i].index;
        chunkShape[arrayDims[i]] = chunks[i].length;
      }
      return this.readRectilinearChunk(keyCoords, chunkShape, signal);
    };

    if (single) {
      // Exactly one zarr chunk, aligned with this one: decode it in place.
      const chunks = zarrChunks[0];
      const data = await read(chunks);
      if (data === undefined) return;
      const size = Uint32Array.from(chunks, (c) => c.length);
      chunk.chunkDataSize = size.every((n, i) => n === spec.chunkDataSize[i])
        ? spec.chunkDataSize
        : size;
      await postProcessRawData(chunk, signal, data);
      return;
    }

    // Assemble the chunk from the parts of the zarr chunks it overlaps.
    const size = Uint32Array.from(lower, (lo, i) => upper[i] - lo);
    const numElements = size.reduce((a, b) => a * b, 1);
    const { dataType, fillValue } = metadata;
    const output = makeDataTypeArrayView(
      dataType,
      new ArrayBuffer(numElements * DATA_TYPE_BYTES[dataType]),
    ) as TypedArray<ArrayBuffer>;
    if (fillValue !== 0 && fillValue !== 0n) {
      (output as any).fill(fillValue);
    }
    const parts = await Promise.all(zarrChunks.map(read));
    for (let k = 0; k < zarrChunks.length; ++k) {
      const data = parts[k];
      if (data === undefined) continue;
      const chunks = zarrChunks[k];
      const destStart = new Array<number>(rank);
      const srcStart = new Array<number>(rank);
      const srcShape = new Array<number>(rank);
      const boxSize = new Array<number>(rank);
      for (let i = 0; i < rank; ++i) {
        const { start, length } = chunks[i];
        const begin = Math.max(lower[i], start);
        const end = Math.min(upper[i], start + length);
        destStart[i] = begin - lower[i];
        srcStart[i] = begin - start;
        srcShape[i] = length;
        boxSize[i] = end - begin;
      }
      copyBox(output, size, destStart, data, srcShape, srcStart, boxSize);
    }
    chunk.chunkDataSize = size;
    await postProcessRawData(chunk, signal, output);
  }
}
