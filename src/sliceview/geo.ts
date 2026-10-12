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
 * @file Slice view support for georeferenced (warped) sources.
 *
 * A georeferenced source has a nonlinear warp `W` (see `src/geo/source_warp.ts`) from true chunk
 * coordinates to the approximate chunk coordinates in which the (affine) chunk layout transform is
 * expressed.  This module determines the visible chunks of such sources by forward-projecting
 * chunk footprints into clip space, and computes the adaptive meshes used to render them.
 *
 * Warped sources are only rendered in cross sections parallel to the plane of the two warped
 * dimensions.  If the display CRS is cylindrical, the source is additionally repeated at
 * multiples of the world period ("world copies").
 */

import type { GeoWarpSpec } from "#src/geo/source_warp.js";
import { ChunkGeoWarp, getMultiscaleGeoWarp } from "#src/geo/source_warp.js";
import { TransformStatus } from "#src/geo/transform.js";
import { computeWarpMesh } from "#src/geo/warp_mesh.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type {
  MultiscaleVolumetricDataRenderLayer,
  TransformedSource,
} from "#src/sliceview/base.js";
import { updateFixedCurPositionInChunks } from "#src/sliceview/base.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { vec3 } from "#src/util/geom.js";

/**
 * Maximum interpolation error of chunk meshes, in voxels.
 */
const GEO_MESH_MAX_ERROR = 0.2;

/**
 * Maximum number of world copies drawn on either side of the canonical copy.
 */
const MAX_WORLD_COPIES = 3;

/**
 * Number of samples per edge used to estimate the footprint of a block of chunks.
 */
const FOOTPRINT_SAMPLES_PER_EDGE = 8;

/**
 * Maximum number of cached chunk meshes per source.
 */
const MAX_CACHED_MESHES = 2048;

/**
 * Cached mesh for a single chunk.
 */
export interface GeoChunkMesh {
  numVertices: number;
  /**
   * Approximate chunk coordinates (i.e. after applying the warp) of each vertex, `[x0, y0, ...]`,
   * for the two warped chunk dimensions.
   */
  warped: Float64Array;
  /**
   * True chunk coordinates of each vertex relative to the chunk origin, `[x0, y0, ...]`.
   */
  positionWithinChunk: Float32Array;
  indices: Uint32Array;
  /**
   * Bounding box of `warped`.
   */
  warpedLower: Float64Array;
  warpedUpper: Float64Array;
}

/**
 * Georeferencing information attached to a `TransformedSource`.
 */
export interface GeoTransformedSourceInfo {
  spec: GeoWarpSpec;
  chunkToMultiscaleTransform: Float32Array | undefined;
  warp: ChunkGeoWarp;
  /**
   * Chunk dimensions corresponding to the two warped dimensions.
   */
  chunkDimensions: [number, number];
  /**
   * Indices into the display subspace of the chunk coordinate space (as used by `ChunkLayout`)
   * corresponding to `chunkDimensions`, or `undefined` if the warped dimensions are not both
   * displayed.
   */
  subspaceIndices: [number, number] | undefined;
  /**
   * The remaining display subspace index.
   */
  thirdSubspaceIndex: number;
  /**
   * Frontend only: cached chunk meshes.
   */
  meshCache?: Map<string, GeoChunkMesh>;
}

function findChunkDimensions(
  spec: GeoWarpSpec,
  chunkToMultiscaleTransform: Float32Array | undefined,
  rank: number,
): [number, number] {
  if (chunkToMultiscaleTransform === undefined) {
    return [spec.multiscaleDimensions[0], spec.multiscaleDimensions[1]];
  }
  const stride = rank + 1;
  const result: number[] = [];
  for (const multiscaleDim of spec.multiscaleDimensions) {
    let found = -1;
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      if (chunkToMultiscaleTransform[chunkDim * stride + multiscaleDim] !== 0) {
        if (found !== -1 && found !== chunkDim) {
          throw new Error(
            "Georeferenced dimensions must correspond to distinct chunk dimensions",
          );
        }
        found = chunkDim;
      }
    }
    if (found === -1) {
      throw new Error(
        "Georeferenced dimension does not correspond to a chunk dimension",
      );
    }
    result.push(found);
  }
  if (result[0] === result[1]) {
    throw new Error(
      "Georeferenced dimensions must correspond to distinct chunk dimensions",
    );
  }
  return [result[0], result[1]];
}

export function makeGeoTransformedSourceInfo(
  spec: GeoWarpSpec,
  chunkToMultiscaleTransform: Float32Array | undefined,
  rank: number,
  chunkDisplayDimensionIndices: readonly number[],
): GeoTransformedSourceInfo {
  const chunkDimensions = findChunkDimensions(
    spec,
    chunkToMultiscaleTransform,
    rank,
  );
  const warp = new ChunkGeoWarp(
    getMultiscaleGeoWarp(spec),
    chunkDimensions,
    chunkToMultiscaleTransform,
    rank,
  );
  const si = chunkDisplayDimensionIndices.indexOf(chunkDimensions[0]);
  const sj = chunkDisplayDimensionIndices.indexOf(chunkDimensions[1]);
  let subspaceIndices: [number, number] | undefined;
  let thirdSubspaceIndex = -1;
  if (si !== -1 && sj !== -1 && si < 3 && sj < 3) {
    subspaceIndices = [si, sj];
    thirdSubspaceIndex = 3 - si - sj;
  }
  return {
    spec,
    chunkToMultiscaleTransform,
    warp,
    chunkDimensions,
    subspaceIndices,
    thirdSubspaceIndex,
  };
}

export function serializeGeoTransformedSourceInfo(
  info: GeoTransformedSourceInfo | undefined,
) {
  if (info === undefined) return undefined;
  return {
    spec: info.spec,
    chunkToMultiscaleTransform: info.chunkToMultiscaleTransform,
  };
}

export function deserializeGeoTransformedSourceInfo(
  obj: any,
  rank: number,
  chunkDisplayDimensionIndices: readonly number[],
): GeoTransformedSourceInfo | undefined {
  if (obj == null) return undefined;
  return makeGeoTransformedSourceInfo(
    obj.spec,
    obj.chunkToMultiscaleTransform,
    rank,
    chunkDisplayDimensionIndices,
  );
}

/**
 * Per-view parameters for rendering and determining visible chunks of a warped source.
 */
export interface GeoViewParameters {
  si: number;
  sj: number;
  sk: number;
  /**
   * Transform from the display subspace of the chunk coordinate space to clip coordinates.
   */
  subspaceToClip: Float64Array;
  /**
   * Coordinate along the third display subspace dimension of the cross section plane.
   */
  thirdCoordinate: number;
  /**
   * Displacement in the display subspace (approximate chunk coordinates) corresponding to one world
   * period, or `undefined`.
   */
  worldPeriodSubspace: vec3 | undefined;
}

function multiplyMat4(
  out: Float64Array,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
) {
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      let sum = 0;
      for (let k = 0; k < 4; ++k) {
        sum += a[k * 4 + i] * b[j * 4 + k];
      }
      out[j * 4 + i] = sum;
    }
  }
  return out;
}

/**
 * Returns the view parameters, or `undefined` if the warped source cannot be displayed in the
 * current view, i.e. if the warped dimensions are not both displayed or the cross section is not
 * parallel to the warped plane.
 */
export function getGeoViewParameters(
  geo: GeoTransformedSourceInfo,
  projectionParameters: ProjectionParameters,
  chunkLayout: ChunkLayout,
): GeoViewParameters | undefined {
  const { subspaceIndices } = geo;
  if (subspaceIndices === undefined) return undefined;
  const [si, sj] = subspaceIndices;
  const sk = geo.thirdSubspaceIndex;
  const { viewMatrix, invViewMatrix } = projectionParameters;
  const { transform, invTransform } = chunkLayout;
  // Check that the warped axes are parallel to the cross section plane.
  for (const s of [si, sj]) {
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < 3; ++i) {
      const t = transform[s * 4 + i];
      dot += viewMatrix[i * 4 + 2] * t;
      norm += t * t;
    }
    let normalNorm = 0;
    for (let i = 0; i < 3; ++i) normalNorm += viewMatrix[i * 4 + 2] ** 2;
    if (Math.abs(dot) > 1e-4 * Math.sqrt(norm * normalNorm)) {
      return undefined;
    }
  }
  const subspaceToClip = multiplyMat4(
    new Float64Array(16),
    projectionParameters.viewProjectionMat,
    transform,
  );
  // Coordinate of the plane along the third subspace dimension.
  let thirdCoordinate = 0;
  for (let i = 0; i < 3; ++i) {
    thirdCoordinate += invTransform[i * 4 + sk] * invViewMatrix[12 + i];
  }
  thirdCoordinate += invTransform[12 + sk];
  let worldPeriodSubspace: vec3 | undefined;
  const { worldPeriod } = geo.warp;
  if (worldPeriod !== undefined) {
    worldPeriodSubspace = vec3.create();
    worldPeriodSubspace[si] = worldPeriod[0];
    worldPeriodSubspace[sj] = worldPeriod[1];
  }
  return { si, sj, sk, subspaceToClip, thirdCoordinate, worldPeriodSubspace };
}

/**
 * Bounding box in clip coordinates (x, y only).
 */
class ClipBounds {
  xMin = Infinity;
  yMin = Infinity;
  xMax = -Infinity;
  yMax = -Infinity;
  invalid = false;

  reset() {
    this.xMin = this.yMin = Infinity;
    this.xMax = this.yMax = -Infinity;
    this.invalid = false;
  }

  addSubspacePoint(m: Float64Array, v: ArrayLike<number>) {
    const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
    const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    const cx = x / w;
    const cy = y / w;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      this.invalid = true;
      return;
    }
    this.xMin = Math.min(this.xMin, cx);
    this.xMax = Math.max(this.xMax, cx);
    this.yMin = Math.min(this.yMin, cy);
    this.yMax = Math.max(this.yMax, cy);
  }

  /**
   * Tests whether the bounds, expanded by `marginFraction` of their size and shifted by
   * `(offsetX, offsetY)`, intersect the viewport `[-1, 1]^2`.
   */
  intersectsViewport(offsetX: number, offsetY: number, marginFraction: number) {
    if (this.invalid) return true;
    if (!(this.xMin <= this.xMax)) return false;
    const mx = (this.xMax - this.xMin) * marginFraction + 1e-3;
    const my = (this.yMax - this.yMin) * marginFraction + 1e-3;
    return (
      this.xMin + offsetX - mx <= 1 &&
      this.xMax + offsetX + mx >= -1 &&
      this.yMin + offsetY - my <= 1 &&
      this.yMax + offsetY + my >= -1
    );
  }
}

const tempWarped = new Float64Array(2);
const tempSubspace = new Float64Array(3);

/**
 * Computes the clip-space bounds of the image of the rectangle `[x0, x1] x [y0, y1]` (true chunk
 * coordinates of the warped dimensions) by sampling its boundary.
 */
function computeFootprintClipBounds(
  bounds: ClipBounds,
  geo: GeoTransformedSourceInfo,
  view: GeoViewParameters,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  bounds.reset();
  const { warp } = geo;
  const { si, sj, sk, subspaceToClip } = view;
  tempSubspace[sk] = view.thirdCoordinate;
  const n = FOOTPRINT_SAMPLES_PER_EDGE;
  const addPoint = (x: number, y: number) => {
    if (warp.forward(x, y, tempWarped) === TransformStatus.INVALID) {
      bounds.invalid = true;
      return;
    }
    tempSubspace[si] = tempWarped[0];
    tempSubspace[sj] = tempWarped[1];
    bounds.addSubspacePoint(subspaceToClip, tempSubspace);
  };
  for (let i = 0; i < n; ++i) {
    const t = i / n;
    addPoint(x0 + t * (x1 - x0), y0);
    addPoint(x1, y0 + t * (y1 - y0));
    addPoint(x1 - t * (x1 - x0), y1);
    addPoint(x0, y1 - t * (y1 - y0));
    if (bounds.invalid) return;
  }
}

/**
 * Returns the clip-space offsets of the world copies (including the canonical copy, offset 0) in
 * which `bounds` intersects the viewport.
 */
function getWorldCopyOffsets(
  bounds: ClipBounds,
  view: GeoViewParameters,
  marginFraction: number,
): number[] {
  const { worldPeriodSubspace, subspaceToClip: m } = view;
  if (worldPeriodSubspace === undefined || bounds.invalid) {
    return bounds.intersectsViewport(0, 0, marginFraction) ? [0, 0, 0] : [];
  }
  const p = worldPeriodSubspace;
  const px = m[0] * p[0] + m[4] * p[1] + m[8] * p[2];
  const py = m[1] * p[0] + m[5] * p[1] + m[9] * p[2];
  const result: number[] = [];
  for (let k = -MAX_WORLD_COPIES; k <= MAX_WORLD_COPIES; ++k) {
    if (bounds.intersectsViewport(k * px, k * py, marginFraction)) {
      result.push(k, k * px, k * py);
    }
  }
  return result;
}

const tempBounds = new ClipBounds();
const tempPositionInChunks = vec3.create();

/**
 * Invokes `callback` for each visible chunk of a warped source.  Each chunk is reported once, even
 * if multiple world copies are visible.
 */
export function forEachGeoVisibleChunk<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(
  projectionParameters: ProjectionParameters,
  localPosition: Float32Array,
  tsource: TransformedSource<RLayer>,
  chunkLayout: ChunkLayout,
  callback: (positionInChunks: vec3) => void,
) {
  const geo = tsource.geo!;
  if (
    !updateFixedCurPositionInChunks(
      tsource,
      projectionParameters.globalPosition,
      localPosition,
    )
  ) {
    return;
  }
  const view = getGeoViewParameters(geo, projectionParameters, chunkLayout);
  if (view === undefined) return;
  const { si, sj, sk } = view;
  const {
    lowerClipDisplayBound,
    upperClipDisplayBound,
    lowerChunkDisplayBound,
    upperChunkDisplayBound,
    curPositionInChunks,
    chunkDisplayDimensionIndices,
  } = tsource;
  const { size } = chunkLayout;

  // Determine the chunk along the third subspace dimension.
  let chunkK: number;
  {
    const BIAS_EPSILON = 1e-4;
    const BOUND_EPSILON = 1e-3;
    const c = view.thirdCoordinate + BIAS_EPSILON;
    const lower = lowerClipDisplayBound[sk];
    const upper = upperClipDisplayBound[sk];
    if (c < lower - BOUND_EPSILON || c >= upper + BOUND_EPSILON) {
      return;
    }
    chunkK = Math.min(
      upperChunkDisplayBound[sk] - 1,
      Math.max(lowerChunkDisplayBound[sk], Math.floor(c / size[sk])),
    );
  }

  const sizeX = size[si];
  const sizeY = size[sj];
  const clipX0 = lowerClipDisplayBound[si];
  const clipY0 = lowerClipDisplayBound[sj];
  const clipX1 = upperClipDisplayBound[si];
  const clipY1 = upperClipDisplayBound[sj];
  const lowerX = lowerChunkDisplayBound[si];
  const lowerY = lowerChunkDisplayBound[sj];
  const upperX = upperChunkDisplayBound[si];
  const upperY = upperChunkDisplayBound[sj];
  if (!(clipX0 < clipX1 && clipY0 < clipY1)) return;

  const bounds = tempBounds;
  computeFootprintClipBounds(bounds, geo, view, clipX0, clipY0, clipX1, clipY1);
  const copies = getWorldCopyOffsets(bounds, view, 0.1);
  if (copies.length === 0) return;

  const visited = new Set<number>();
  const numY = upperY - lowerY;
  const positionInChunks = tempPositionInChunks;
  positionInChunks[sk] = chunkK;
  const chunkDimX = chunkDisplayDimensionIndices[si];
  const chunkDimY = chunkDisplayDimensionIndices[sj];
  const chunkDimK = chunkDisplayDimensionIndices[sk];
  curPositionInChunks[chunkDimK] = chunkK;

  const emit = (x: number, y: number) => {
    const key = (x - lowerX) * numY + (y - lowerY);
    if (visited.has(key)) return;
    visited.add(key);
    positionInChunks[si] = x;
    positionInChunks[sj] = y;
    curPositionInChunks[chunkDimX] = x;
    curPositionInChunks[chunkDimY] = y;
    curPositionInChunks[chunkDimK] = chunkK;
    callback(positionInChunks);
  };

  for (let copyIndex = 0; copyIndex < copies.length; copyIndex += 3) {
    const offsetX = copies[copyIndex + 1];
    const offsetY = copies[copyIndex + 2];
    const recurse = (x0: number, y0: number, x1: number, y1: number) => {
      computeFootprintClipBounds(
        bounds,
        geo,
        view,
        Math.max(clipX0, x0 * sizeX),
        Math.max(clipY0, y0 * sizeY),
        Math.min(clipX1, x1 * sizeX),
        Math.min(clipY1, y1 * sizeY),
      );
      if (!bounds.intersectsViewport(offsetX, offsetY, 0.1)) return;
      const nx = x1 - x0;
      const ny = y1 - y0;
      if (nx === 1 && ny === 1) {
        emit(x0, y0);
        return;
      }
      if (nx >= ny) {
        const mid = x0 + Math.floor(nx / 2);
        recurse(x0, y0, mid, y1);
        recurse(mid, y0, x1, y1);
      } else {
        const mid = y0 + Math.floor(ny / 2);
        recurse(x0, y0, x1, mid);
        recurse(x0, mid, x1, y1);
      }
    };
    recurse(lowerX, lowerY, upperX, upperY);
  }
}

/**
 * Computes the chunk mesh for the chunk at grid position `(gridX, gridY)` of the warped
 * dimensions.
 */
export function computeGeoChunkMesh(
  tsource: TransformedSource<any>,
  chunkLayout: ChunkLayout,
  gridX: number,
  gridY: number,
  si: number,
  sj: number,
): GeoChunkMesh {
  const geo = tsource.geo!;
  const { size } = chunkLayout;
  const { lowerClipDisplayBound, upperClipDisplayBound } = tsource;
  const originX = gridX * size[si];
  const originY = gridY * size[sj];
  const x0 = Math.max(lowerClipDisplayBound[si], originX);
  const y0 = Math.max(lowerClipDisplayBound[sj], originY);
  const x1 = Math.min(upperClipDisplayBound[si], originX + size[si]);
  const y1 = Math.min(upperClipDisplayBound[sj], originY + size[sj]);
  const mesh = computeWarpMesh(geo.warp, x0, y0, x1, y1, {
    maxError: GEO_MESH_MAX_ERROR,
  });
  const { numVertices, sourcePositions, outputPositions } = mesh;
  const positionWithinChunk = new Float32Array(numVertices * 2);
  const warpedLower = Float64Array.of(Infinity, Infinity);
  const warpedUpper = Float64Array.of(-Infinity, -Infinity);
  for (let i = 0; i < numVertices; ++i) {
    positionWithinChunk[2 * i] = sourcePositions[2 * i] - originX;
    positionWithinChunk[2 * i + 1] = sourcePositions[2 * i + 1] - originY;
    const wx = outputPositions[2 * i];
    const wy = outputPositions[2 * i + 1];
    if (Number.isFinite(wx)) {
      warpedLower[0] = Math.min(warpedLower[0], wx);
      warpedLower[1] = Math.min(warpedLower[1], wy);
      warpedUpper[0] = Math.max(warpedUpper[0], wx);
      warpedUpper[1] = Math.max(warpedUpper[1], wy);
    }
  }
  return {
    numVertices,
    warped: outputPositions,
    positionWithinChunk,
    indices: mesh.indices,
    warpedLower,
    warpedUpper,
  };
}

/**
 * Returns the (cached) mesh for a chunk.
 */
export function getGeoChunkMesh(
  tsource: TransformedSource<any>,
  chunkLayout: ChunkLayout,
  key: string,
  gridX: number,
  gridY: number,
  si: number,
  sj: number,
): GeoChunkMesh {
  const geo = tsource.geo!;
  let cache = geo.meshCache;
  if (cache === undefined) {
    cache = geo.meshCache = new Map();
  }
  let mesh = cache.get(key);
  if (mesh !== undefined) {
    // Move to the end to maintain LRU order.
    cache.delete(key);
    cache.set(key, mesh);
    return mesh;
  }
  mesh = computeGeoChunkMesh(tsource, chunkLayout, gridX, gridY, si, sj);
  cache.set(key, mesh);
  if (cache.size > MAX_CACHED_MESHES) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
  return mesh;
}

/**
 * Returns the clip-space offsets (as `[copyIndex, offsetX, offsetY, ...]`) of the world copies of a
 * chunk mesh that intersect the viewport.
 */
export function getGeoChunkMeshCopies(
  mesh: GeoChunkMesh,
  view: GeoViewParameters,
): number[] {
  const bounds = tempBounds;
  bounds.reset();
  const { si, sj, sk, subspaceToClip } = view;
  tempSubspace[sk] = view.thirdCoordinate;
  const { warpedLower, warpedUpper } = mesh;
  if (!(warpedLower[0] <= warpedUpper[0])) return [];
  for (const x of [warpedLower[0], warpedUpper[0]]) {
    for (const y of [warpedLower[1], warpedUpper[1]]) {
      tempSubspace[si] = x;
      tempSubspace[sj] = y;
      bounds.addSubspacePoint(subspaceToClip, tempSubspace);
    }
  }
  return getWorldCopyOffsets(bounds, view, 0);
}

/**
 * Updates `tsource.effectiveVoxelSize` based on the local scale of the warp at the center of the
 * view.
 */
export function updateGeoEffectiveVoxelSize(
  tsource: TransformedSource<any>,
  projectionParameters: ProjectionParameters,
  globalScales: ArrayLike<number>,
  displayRank: number,
) {
  const geo = tsource.geo!;
  const { subspaceIndices } = geo;
  if (subspaceIndices === undefined) return;
  const [si, sj] = subspaceIndices;
  const sk = geo.thirdSubspaceIndex;
  const { chunkLayout, lowerClipDisplayBound, upperClipDisplayBound } = tsource;
  const { transform, invTransform } = chunkLayout;
  const { invViewMatrix } = projectionParameters;
  // Approximate chunk coordinates of the center of the view.
  const approx = [0, 0];
  for (const [index, s] of [
    [0, si],
    [1, sj],
  ]) {
    let sum = invTransform[12 + s];
    for (let i = 0; i < 3; ++i) {
      sum += invTransform[i * 4 + s] * invViewMatrix[12 + i];
    }
    approx[index] = sum;
  }
  const { warp } = geo;
  const center = new Float64Array(2);
  const x0 = lowerClipDisplayBound[si];
  const x1 = upperClipDisplayBound[si];
  const y0 = lowerClipDisplayBound[sj];
  const y1 = upperClipDisplayBound[sj];
  if (warp.inverse(approx[0], approx[1], center) === TransformStatus.INVALID) {
    center[0] = 0.5 * (x0 + x1);
    center[1] = 0.5 * (y0 + y1);
  }
  const h = 0.5;
  center[0] = Math.min(x1 - h, Math.max(x0, center[0]));
  center[1] = Math.min(y1 - h, Math.max(y0, center[1]));
  const p0 = new Float64Array(2);
  const px = new Float64Array(2);
  const py = new Float64Array(2);
  const { effectiveVoxelSize } = tsource;
  if (
    warp.forward(center[0], center[1], p0) === TransformStatus.INVALID ||
    warp.forward(center[0] + h, center[1], px) === TransformStatus.INVALID ||
    warp.forward(center[0], center[1] + h, py) === TransformStatus.INVALID
  ) {
    return;
  }
  const jx0 = (px[0] - p0[0]) / h;
  const jx1 = (px[1] - p0[1]) / h;
  const jy0 = (py[0] - p0[0]) / h;
  const jy1 = (py[1] - p0[1]) / h;
  for (let d = 0; d < 3; ++d) {
    if (d >= displayRank) {
      effectiveVoxelSize[d] = 1;
      continue;
    }
    // Displacement in display dimension `d` of a unit step in each warped chunk dimension.
    const tsi = transform[si * 4 + d];
    const tsj = transform[sj * 4 + d];
    const dx = tsi * jx0 + tsj * jx1;
    const dy = tsi * jy0 + tsj * jy1;
    const dk = transform[sk * 4 + d];
    effectiveVoxelSize[d] =
      (Math.abs(dx) + Math.abs(dy) + Math.abs(dk)) * globalScales[d];
  }
}

/**
 * Converts approximate chunk coordinates (as computed from the affine chunk transform) of the
 * warped dimensions in `chunkPosition` to true chunk coordinates.  Returns `false` if the position
 * is outside the domain of the warp.
 */
export function correctGeoChunkPosition(
  warp: ChunkGeoWarp,
  chunkPosition: Float32Array,
): boolean {
  const [d0, d1] = warp.chunkDimensions;
  if (warp.isIdentity) return true;
  if (
    warp.inverse(chunkPosition[d0], chunkPosition[d1], tempWarped) ===
    TransformStatus.INVALID
  ) {
    return false;
  }
  chunkPosition[d0] = tempWarped[0];
  chunkPosition[d1] = tempWarped[1];
  return true;
}
