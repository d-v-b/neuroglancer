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
 * @file Backend of `StackedVolumeChunkSource` (see `src/sliceview/volume/stacked.ts`).
 */

import {
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import type { VolumeChunkSpecification } from "#src/sliceview/volume/base.js";
import { STACKED_VOLUME_CHUNK_SOURCE_RPC_ID } from "#src/sliceview/volume/stacked_base.js";
import { DATA_TYPE_ARRAY_CONSTRUCTOR, DataType } from "#src/util/data_type.js";
import type { vec3 } from "#src/util/geom.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObject } from "#src/worker_rpc.js";

interface SampleArray extends ArrayBufferView {
  fill(value: never): unknown;
  set(array: never, offset: number): void;
}

/**
 * Returns the number of elements of a chunk of the specified size, excluding the dimension `skip`.
 */
function getSlabSize(size: ArrayLike<number>, rank: number, skip: number) {
  let n = 1;
  for (let i = 0; i < rank; ++i) {
    if (i !== skip) n *= size[i];
  }
  return n;
}

@registerSharedObject(STACKED_VOLUME_CHUNK_SOURCE_RPC_ID)
export class StackedVolumeChunkSource extends VolumeChunkSource {
  sources: VolumeChunkSource[];

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.sources = (options.sources as number[]).map((id) => rpc.get(id));
  }

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const spec = this.spec as VolumeChunkSpecification;
    const { rank } = spec;
    // The channel dimension is the last (outermost) dimension, such that the samples of each
    // channel are contiguous.
    const stackDim = rank - 1;
    this.computeChunkBounds(chunk);
    const size = chunk.chunkDataSize!;
    const slab = getSlabSize(size, rank, stackDim);
    const output = new (DATA_TYPE_ARRAY_CONSTRUCTOR[
      spec.dataType
    ] as unknown as new (length: number) => SampleArray)(slab * size[stackDim]);
    // Channels whose chunks have no data are filled with the fill value (NaN for floats).
    output.fill(
      (spec.dataType === DataType.FLOAT32
        ? Number.NaN
        : spec.fillValue) as never,
    );
    let offset = 0;
    await Promise.all(
      this.sources.map(async (source) => {
        const sourceRank = source.spec.rank;
        const channels =
          sourceRank < rank ? 1 : source.spec.chunkDataSize[stackDim];
        const channelOffset = offset;
        offset += channels;
        const sub = new VolumeChunk();
        sub.source = source;
        sub.initializeVolumeChunk(
          "",
          chunk.chunkGridPosition.subarray(0, sourceRank) as unknown as vec3,
        );
        await source.download(sub, signal);
        const { data } = sub;
        if (data == null) return;
        output.set(data as never, channelOffset * slab);
      }),
    );
    chunk.data = output;
  }
}
