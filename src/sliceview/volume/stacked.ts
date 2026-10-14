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
 * @file Combination of multiple volume sources (e.g. the spectral bands of a satellite image,
 * stored as separate arrays or files) as the channels of a single volume, such that a shader can
 * combine them.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type {
  VolumeChunkSpecification,
  VolumeSourceOptions,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import {
  alignStackedLevels,
  getChunkToRenderLayerTransform,
  STACKED_VOLUME_CHUNK_SOURCE_RPC_ID,
} from "#src/sliceview/volume/stacked_base.js";
import { getObjectId } from "#src/util/object_id.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerSharedObjectOwner } from "#src/worker_rpc.js";

/**
 * Chunk source whose chunks combine the chunks (at the same grid position) of multiple chunk
 * sources along the channel dimension, which is the last (outermost) chunk dimension.
 */
@registerSharedObjectOwner(STACKED_VOLUME_CHUNK_SOURCE_RPC_ID)
export class StackedVolumeChunkSource extends VolumeChunkSource {
  declare OPTIONS: {
    spec: VolumeChunkSpecification;
    sources: VolumeChunkSource[];
  };
  sources: VolumeChunkSource[];

  constructor(chunkManager: ChunkManager, options: any) {
    super(chunkManager, options);
    this.sources = options.sources;
    for (const source of this.sources) {
      this.registerDisposer(source.addRef());
    }
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.sources = this.sources.map((source) => source.rpcId);
    super.initializeCounterpart(rpc, options);
  }

  static encodeOptions(options: any) {
    return {
      ...VolumeChunkSource.encodeOptions(options),
      sources: (options.sources as VolumeChunkSource[]).map((source) =>
        getObjectId(source),
      ),
    };
  }
}

/**
 * A source combined by `StackedMultiscaleVolumeChunkSource`.
 */
export interface StackedVolumeSource {
  volume: MultiscaleVolumeChunkSource;
  /**
   * Returns the current transform from the model space of the source to the render layer space
   * (see `RenderLayerTransform`), used to match the resolution levels of the sources, or
   * `undefined` if it is invalid.
   */
  getModelToRenderLayerTransform: () =>
    | { rank: number; modelToRenderLayerTransform: Float32Array }
    | undefined;
}

/**
 * Multiscale volume combining multiple volumes with the same data type as channels.  If the
 * volumes have a channel dimension (`channelDim`, which must be their last dimension), their
 * channels are concatenated; otherwise, a channel dimension is appended.  The combined volume has
 * the resolution levels at which all volumes have the same voxel grid (see `alignStackedLevels`),
 * and the geometry (and georeferencing) of the first volume.
 */
export class StackedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  /**
   * Number of channels of each source.
   */
  sourceChannels: number[];

  constructor(
    chunkManager: ChunkManager,
    public sources: StackedVolumeSource[],
    public channelDim: number | undefined,
    sourceChannels: number[],
  ) {
    super(chunkManager);
    this.sourceChannels = sourceChannels;
    const { dataType } = sources[0].volume;
    for (const { volume } of sources) {
      if (volume.dataType !== dataType) {
        throw new Error("Combined sources must have the same data type");
      }
    }
  }

  get numChannels() {
    return this.sourceChannels.reduce((a, b) => a + b, 0);
  }

  get dataType() {
    return this.sources[0].volume.dataType;
  }

  get volumeType() {
    return this.sources[0].volume.volumeType;
  }

  get baseRank() {
    return this.sources[0].volume.rank;
  }

  get rank() {
    return this.baseRank + (this.channelDim === undefined ? 1 : 0);
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    const { sources, channelDim, baseRank, rank } = this;
    const appended = channelDim === undefined;
    const stackDim = appended ? baseRank : channelDim;
    // Options for the sources, without the appended channel dimension.
    const sourceOptions: VolumeSourceOptions = appended
      ? {
          ...options,
          multiscaleToViewTransform: options.multiscaleToViewTransform.slice(
            0,
            baseRank * options.displayRank,
          ),
          modelChannelDimensionIndices:
            options.modelChannelDimensionIndices.filter((d) => d < baseRank),
        }
      : options;
    const sourceLevels = sources.map(
      ({ volume }) => volume.getSources(sourceOptions)[0],
    );
    const spatialDims: number[] = [];
    for (let dim = 0; dim < baseRank; ++dim) {
      if (dim !== stackDim) spatialDims.push(dim);
    }
    const renderTransforms = sources.map((source) =>
      source.getModelToRenderLayerTransform(),
    );
    const aligned = alignStackedLevels(
      sourceLevels.map((levels, i) => {
        const renderTransform = renderTransforms[i];
        if (renderTransform === undefined) return [];
        return levels.map((level) => ({
          chunkToRenderLayer: getChunkToRenderLayerTransform(
            renderTransform.modelToRenderLayerTransform,
            renderTransform.rank,
            baseRank,
            level.chunkToMultiscaleTransform,
          ),
          upperVoxelBound: level.chunkSource.spec.upperVoxelBound,
          chunkDataSize: level.chunkSource.spec.chunkDataSize,
        }));
      }),
      spatialDims,
    );
    if (aligned.length === 0) {
      for (const levels of sourceLevels) {
        for (const level of levels) level.chunkSource.dispose();
      }
      throw new Error(
        "Combined sources have no resolution level with the same voxel grid",
      );
    }
    const numChannels = this.numChannels;
    const extend = (values: ArrayLike<number>, last: number) => {
      const result = new Float32Array(rank);
      result.set(Array.from(values).slice(0, baseRank));
      result[stackDim] = last;
      return result;
    };
    const levels = aligned.map((indices) => {
      const entries = indices.map((level, i) => sourceLevels[i][level]);
      const first = entries[0];
      const firstSpec = first.chunkSource.spec;
      const chunkDataSize = new Uint32Array(rank);
      chunkDataSize.set(Array.from(firstSpec.chunkDataSize).slice(0, baseRank));
      chunkDataSize[stackDim] = numChannels;
      const lowerVoxelBound = extend(firstSpec.lowerVoxelBound, 0);
      const upperVoxelBound = extend(firstSpec.upperVoxelBound, numChannels);
      const lowerChunkBound = extend(firstSpec.lowerChunkBound, 0);
      const upperChunkBound = extend(firstSpec.upperChunkBound, 1);
      const spec: VolumeChunkSpecification = {
        rank,
        chunkDataSize,
        lowerVoxelBound,
        upperVoxelBound,
        lowerChunkBound,
        upperChunkBound,
        baseVoxelOffset: extend(firstSpec.baseVoxelOffset, 0),
        dataType: firstSpec.dataType,
        compressedSegmentationBlockSize: undefined,
        fillValue: firstSpec.fillValue,
      };
      const chunkSource = this.chunkManager.getChunkSource(
        StackedVolumeChunkSource,
        { spec, sources: entries.map((entry) => entry.chunkSource) },
      );
      let { chunkToMultiscaleTransform } = first;
      let { lowerClipBound, upperClipBound } = first;
      if (appended) {
        // Extend the transform with the identity for the channel dimension.
        const stride = rank + 1;
        const transform = new Float32Array(stride * stride);
        for (let col = 0; col <= baseRank; ++col) {
          for (let row = 0; row <= baseRank; ++row) {
            transform[
              (col === baseRank ? rank : col) * stride +
                (row === baseRank ? rank : row)
            ] = chunkToMultiscaleTransform[col * (baseRank + 1) + row];
          }
        }
        transform[baseRank * stride + baseRank] = 1;
        chunkToMultiscaleTransform = transform;
        if (lowerClipBound !== undefined) {
          lowerClipBound = extend(lowerClipBound, 0);
        }
        if (upperClipBound !== undefined) {
          upperClipBound = extend(upperClipBound, numChannels);
        }
      } else {
        if (upperClipBound !== undefined) {
          upperClipBound = Float32Array.from(upperClipBound);
          upperClipBound[stackDim] = numChannels;
        }
      }
      return {
        ...first,
        chunkSource,
        chunkToMultiscaleTransform,
        lowerClipBound,
        upperClipBound,
      };
    });
    // The stacked chunk sources hold references to the chunk sources of the sources; release
    // those obtained above.
    for (const levels of sourceLevels) {
      for (const level of levels) level.chunkSource.dispose();
    }
    return [levels];
  }
}
