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
 * @file Helpers for determining the chunks of transformed sources intersecting a view.
 */

import type { ProjectionParameters } from "#src/projection_parameters.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
import type {
  MultiscaleVolumetricDataRenderLayer,
  SliceViewChunkSource,
  TransformedSource,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { getViewFrustumDepthRange, mat4, vec3 } from "#src/util/geom.js";

const DEBUG_VISIBLE_SOURCES = false;

const tempChunkLayout = new ChunkLayout(vec3.create(), mat4.create(), 0);

export function updateFixedCurPositionInChunks<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(
  tsource: TransformedSource<RLayer, SliceViewChunkSource>,
  globalPosition: Float32Array,
  localPosition: Float32Array,
): boolean {
  const { curPositionInChunks, fixedPositionWithinChunk } = tsource;
  const { nonDisplayLowerClipBound, nonDisplayUpperClipBound } = tsource;
  const { rank, chunkDataSize, lowerChunkBound, upperChunkBound } =
    tsource.source.spec;
  if (
    !getChunkPositionFromCombinedGlobalLocalPositions(
      curPositionInChunks,
      globalPosition,
      localPosition,
      tsource.layerRank,
      tsource.fixedLayerToChunkTransform,
    )
  ) {
    return false;
  }
  // Fraction by which non-display dimensions can be outside clip bounds, to
  // account for floating-point imprecision.
  const EPSILON = 1e-3;
  for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
    const x = curPositionInChunks[chunkDim];
    if (
      x < nonDisplayLowerClipBound[chunkDim] - EPSILON ||
      x > nonDisplayUpperClipBound[chunkDim] + EPSILON
    ) {
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(
          "excluding source",
          tsource,
          `because of chunkDim=${chunkDim}, sum=${x}`,
          nonDisplayLowerClipBound,
          nonDisplayUpperClipBound,
          tsource.fixedLayerToChunkTransform,
        );
      }
      return false;
    }
    const chunkSize = chunkDataSize[chunkDim];
    // Given that clip bounds are already tested above, clamp chunk index to its
    // bounds, to ensure floating-point imprecision does not result in an
    // out-of-bounds index.
    const chunk = (curPositionInChunks[chunkDim] = Math.min(
      upperChunkBound[chunkDim] - 1,
      Math.max(lowerChunkBound[chunkDim], Math.floor(x / chunkSize)),
    ));
    fixedPositionWithinChunk[chunkDim] = x - chunk * chunkSize;
  }
  return true;
}

/**
 * For chunk layouts with finiteRank < 3, returns an adjusted chunk layout where chunk 0 in each
 * non-finite dimension is guaranteed to cover the viewport.
 */
export function getNormalizedChunkLayout(
  projectionParameters: ProjectionParameters,
  chunkLayout: ChunkLayout,
): ChunkLayout {
  const { finiteRank } = chunkLayout;
  if (finiteRank === 3) return chunkLayout;
  tempChunkLayout.finiteRank = finiteRank;
  vec3.copy(tempChunkLayout.size, chunkLayout.size);
  const transform = mat4.copy(tempChunkLayout.transform, chunkLayout.transform);
  const invTransform = mat4.copy(
    tempChunkLayout.invTransform,
    chunkLayout.invTransform,
  );
  tempChunkLayout.detTransform = chunkLayout.detTransform;
  const { invViewMatrix, width, height } = projectionParameters;
  const depth = getViewFrustumDepthRange(projectionParameters.projectionMat);
  for (let chunkRenderDim = finiteRank; chunkRenderDim < 3; ++chunkRenderDim) {
    // we want to ensure chunk [0] fully covers the viewport
    const offset = invViewMatrix[12 + chunkRenderDim];
    let lower = offset;
    let upper = offset;
    const xc = Math.abs(invViewMatrix[chunkRenderDim] * width);
    lower -= xc;
    upper += xc;
    const yc = Math.abs(invViewMatrix[chunkRenderDim + 4] * height);
    lower -= yc;
    upper += yc;
    const zc = Math.abs(invViewMatrix[chunkRenderDim + 8] * depth);
    lower -= zc;
    upper += zc;
    const scaleFactor = Math.max(1, upper - lower);
    transform[12 + chunkRenderDim] = lower;
    transform[5 * chunkRenderDim] = scaleFactor;
  }
  mat4.invert(invTransform, transform);
  return tempChunkLayout;
}
