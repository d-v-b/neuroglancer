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
 * @file Combination of multiple volume sources as the channels of a single volume (see
 * `StackedMultiscaleVolumeChunkSource`), shared by the frontend and backend.
 */

import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";

export const STACKED_VOLUME_CHUNK_SOURCE_RPC_ID =
  "sliceview/volume/StackedVolumeChunkSource";

/**
 * Returns the transform from the chunk coordinates of a resolution level of a source to the
 * render layer coordinates (the global and local coordinates shared by all sources of a layer), as
 * a `(chunkRank + 1) x (renderRank + 1)` column-major matrix.  Resolution levels of different
 * sources with equal transforms have the same voxel grid.
 *
 * @param modelToRenderLayerTransform `(renderRank + 1)^2` transform from model coordinates to
 *     render layer coordinates (see `RenderLayerTransform`).
 * @param chunkToMultiscaleTransform `(chunkRank + 1)^2` transform from the chunk coordinates of
 *     the level to model coordinates.
 */
export function getChunkToRenderLayerTransform(
  modelToRenderLayerTransform: ArrayLike<number>,
  renderRank: number,
  chunkRank: number,
  chunkToMultiscaleTransform: ArrayLike<number>,
): Float64Array {
  const stride = renderRank + 1;
  const chunkStride = chunkRank + 1;
  const result = new Float64Array(chunkStride * stride);
  for (let col = 0; col <= chunkRank; ++col) {
    for (let row = 0; row < renderRank; ++row) {
      let sum = 0;
      for (let k = 0; k <= chunkRank; ++k) {
        const c = chunkToMultiscaleTransform[col * chunkStride + k];
        if (c === 0) continue;
        const modelDim = k === chunkRank ? renderRank : k;
        sum += modelToRenderLayerTransform[modelDim * stride + row] * c;
      }
      result[col * stride + row] = sum;
    }
    result[col * stride + renderRank] = col === chunkRank ? 1 : 0;
  }
  return result;
}

/**
 * Description of a resolution level of a source, for `alignStackedLevels`.
 */
export interface StackedLevelInfo {
  /**
   * Transform from chunk coordinates to render layer coordinates (see
   * `getChunkToRenderLayerTransform`).
   */
  chunkToRenderLayer: Float64Array;
  upperVoxelBound: ArrayLike<number>;
  chunkDataSize: ArrayLike<number>;
}

/**
 * Relative tolerance for matching resolution levels.
 */
const LEVEL_MATCH_TOLERANCE = 1e-6;

function levelsMatch(
  a: StackedLevelInfo,
  b: StackedLevelInfo,
  spatialDims: readonly number[],
) {
  for (const dim of spatialDims) {
    if (
      a.upperVoxelBound[dim] !== b.upperVoxelBound[dim] ||
      a.chunkDataSize[dim] !== b.chunkDataSize[dim]
    ) {
      return false;
    }
  }
  const x = a.chunkToRenderLayer;
  const y = b.chunkToRenderLayer;
  if (x.length !== y.length) return false;
  let scale = 0;
  for (let i = 0; i < x.length; ++i) scale = Math.max(scale, Math.abs(x[i]));
  const tolerance = LEVEL_MATCH_TOLERANCE * Math.max(scale, 1e-12);
  for (let i = 0; i < x.length; ++i) {
    if (Math.abs(x[i] - y[i]) > tolerance) return false;
  }
  return true;
}

/**
 * Determines the resolution levels at which multiple sources can be combined: the levels of the
 * first source for which every other source has a level with the same voxel grid (chunk size,
 * bounds, and placement in physical coordinates) along the spatial dimensions.
 *
 * @param levels For each source, its resolution levels (ordered from the finest).
 * @param spatialDims Chunk dimensions that must match (all except the channel dimension).
 * @returns For each combined level, the level index of each source.
 */
export function alignStackedLevels(
  levels: StackedLevelInfo[][],
  spatialDims: readonly number[],
): number[][] {
  const result: number[][] = [];
  for (const level of levels[0]) {
    const indices: number[] = [];
    for (const sourceLevels of levels) {
      const index = sourceLevels.findIndex((other) =>
        levelsMatch(level, other, spatialDims),
      );
      if (index === -1) break;
      indices.push(index);
    }
    if (indices.length === levels.length) result.push(indices);
  }
  return result;
}

/**
 * Returns a transform with an additional source dimension `name` of the specified size, mapped
 * by the identity to an additional output dimension of the same name.  Used to embed sources
 * combined along an appended channel dimension (see `StackedMultiscaleVolumeChunkSource`) in the
 * layer space.
 */
export function appendChannelDimension(
  transform: CoordinateSpaceTransform,
  name: string,
  size: number,
): CoordinateSpaceTransform {
  const { rank, sourceRank, inputSpace, outputSpace } = transform;
  const newRank = rank + 1;
  const stride = rank + 1;
  const newStride = newRank + 1;
  // Input dimension `sourceRank` is inserted (before any synthetic input dimensions); output
  // dimension `rank` is appended.
  const newInputIndex = (i: number) =>
    i === rank ? newRank : i < sourceRank ? i : i + 1;
  const newTransform = new Float64Array(newStride * newStride);
  for (let col = 0; col <= rank; ++col) {
    for (let row = 0; row < rank; ++row) {
      newTransform[newInputIndex(col) * newStride + row] =
        transform.transform[col * stride + row];
    }
  }
  newTransform[sourceRank * newStride + rank] = 1;
  newTransform[newStride * newStride - 1] = 1;
  const insert = <T>(values: readonly T[], value: T) => {
    const result = Array.from(values);
    result.splice(sourceRank, 0, value);
    return result;
  };
  const { bounds } = inputSpace;
  const newInputSpace = makeCoordinateSpace({
    valid: inputSpace.valid,
    names: insert(inputSpace.names, name),
    units: insert(inputSpace.units, ""),
    scales: Float64Array.from(insert(Array.from(inputSpace.scales), 1)),
    bounds: {
      lowerBounds: Float64Array.from(insert(Array.from(bounds.lowerBounds), 0)),
      upperBounds: Float64Array.from(
        insert(Array.from(bounds.upperBounds), size),
      ),
      voxelCenterAtIntegerCoordinates: insert(
        bounds.voxelCenterAtIntegerCoordinates,
        false,
      ),
    },
    coordinateArrays: insert(inputSpace.coordinateArrays, undefined),
  });
  const newOutputSpace = makeCoordinateSpace({
    valid: outputSpace.valid,
    names: [...outputSpace.names, name],
    units: [...outputSpace.units, ""],
    scales: Float64Array.from([...outputSpace.scales, 1]),
    coordinateArrays: [...outputSpace.coordinateArrays, undefined],
  });
  return {
    rank: newRank,
    sourceRank: sourceRank + 1,
    inputSpace: newInputSpace,
    outputSpace: newOutputSpace,
    transform: newTransform,
  };
}
