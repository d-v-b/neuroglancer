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

import type { Affine2d, GeoWarpSpec } from "#src/geo/source_warp.js";
import { ChunkGeoWarp, getMultiscaleGeoWarp } from "#src/geo/source_warp.js";
import { TransformStatus } from "#src/geo/transform.js";
import { computeWarpMesh } from "#src/geo/warp_mesh.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type {
  MultiscaleVolumetricDataRenderLayer,
  TransformedSource,
} from "#src/sliceview/base.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import {
  getNormalizedChunkLayout,
  updateFixedCurPositionInChunks,
} from "#src/sliceview/chunk_position.js";
import type { GeoLevelInput, GeoLevelPlan } from "#src/sliceview/geo_levels.js";
import {
  computeGeoLevelPlan,
  geoLevelChunkFromKey,
} from "#src/sliceview/geo_levels.js";
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
 * Minimum number of chunk meshes retained in the cache of each source.  The cache additionally
 * always retains the meshes used in the current and previous frame, and up to
 * `MESH_CACHE_FRAME_MULTIPLIER` times the number of meshes used in the previous frame, such that
 * the meshes of the visible chunks are not recomputed every frame when many chunks are visible.
 */
const MIN_CACHED_MESHES = 2048;

const MESH_CACHE_FRAME_MULTIPLIER = 2;

/**
 * Maximum total number of vertices of the cached chunk meshes of a source.  The memory used by
 * chunk meshes (CPU arrays plus GPU buffers, roughly 100 bytes per vertex including indices) is not
 * tracked by the chunk manager; this bounds it to roughly 100 MB per source.  Meshes used in the
 * current or previous frame are retained even if this limit is exceeded.
 */
const MAX_CACHED_MESH_VERTICES = 1 << 20;

/**
 * Maximum number of cached block footprints per source (see `forEachGeoVisibleChunk`).  Each entry
 * uses roughly 150 bytes.
 */
const MAX_CACHED_FOOTPRINTS = 1 << 17;

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
  /**
   * Frontend only: GPU resources for rendering the mesh, disposed with the mesh.
   */
  gpuMesh?: { dispose(): void };
  /**
   * Value of `GeoMeshCache.generation` when the mesh was last used.
   */
  generation?: number;
}

/**
 * Cache of chunk meshes of a source, in least-recently-used order.
 */
export class GeoMeshCache {
  meshes = new Map<string, GeoChunkMesh>();
  /**
   * Incremented at the start of each frame by `beginGeoMeshFrame`.
   */
  generation = 0;
  /**
   * Number of distinct meshes used in the previous and current frame.
   */
  previousFrameCount = 0;
  currentFrameCount = 0;
  totalVertices = 0;
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
  meshCache?: GeoMeshCache;
  /**
   * Cached footprints of blocks of chunks (see `forEachGeoVisibleChunk`).
   */
  footprintCache?: GeoFootprintCache;
  /**
   * If set, the visible chunks are determined jointly for all resolution levels of the source (see
   * `src/sliceview/geo_levels.ts`), and this is the index of this level (0 is the finest).
   */
  levelGroup?: GeoLevelGroup;
  levelIndex?: number;
}

/**
 * The resolution levels of a warped multiscale source, whose visible chunks are determined jointly.
 */
export interface GeoLevelGroup {
  /**
   * Levels from finest to coarsest.
   */
  sources: readonly TransformedSource<any>[];
  planCache: {
    key: Float64Array;
    plan: GeoLevelPlan;
    inputs: GeoLevelInput[];
  }[];
}

/**
 * Footprints, in approximate chunk coordinates, of the blocks of chunks visited by
 * `forEachGeoVisibleChunk`.  The footprints do not depend on the view, so they are computed once
 * (which requires many evaluations of the warp) and reused across frames.  Valid as long as `key`,
 * which encodes the clip and chunk bounds, is unchanged.
 */
interface GeoFootprintCache {
  key: string;
  nodes: Map<number, Float64Array>;
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

export enum GeoRenderingMode {
  /** The source is not shown in the current view. */
  HIDDEN = 0,
  /** The source is rendered using the regular (affine) path. */
  AFFINE = 1,
  /** The source is rendered using warped meshes. */
  WARPED = 2,
}

/**
 * Determines how a georeferenced source is rendered in the current view.
 *
 * In cross sections parallel to the map plane, all georeferenced sources are rendered using the
 * warped path, which supports world copies.  In other cross sections (e.g. vertical sections
 * through a georeferenced volume), sources whose warp is the identity (i.e. sources in the display
 * CRS) are rendered using the regular (affine) path, provided that they extend along all displayed
 * dimensions; 2-d sources such as map tiles are hidden rather than being extruded.  Other warped
 * sources cannot be shown in such cross sections.
 */
export function getGeoRenderingMode(
  tsource: TransformedSource<any>,
  projectionParameters: ProjectionParameters,
  chunkLayout: ChunkLayout,
): GeoRenderingMode {
  const { geo } = tsource;
  if (geo === undefined) return GeoRenderingMode.AFFINE;
  if (
    getGeoViewParameters(geo, projectionParameters, chunkLayout) !== undefined
  ) {
    return GeoRenderingMode.WARPED;
  }
  if (!geo.warp.isIdentity) return GeoRenderingMode.HIDDEN;
  const { displayRank } = projectionParameters.displayDimensionRenderInfo;
  if (chunkLayout.finiteRank < displayRank) return GeoRenderingMode.HIDDEN;
  return GeoRenderingMode.AFFINE;
}

/**
 * Bounding box in clip coordinates (x, y only).
 */
class ClipBounds {
  xMin = Infinity;
  yMin = Infinity;
  xMax = -Infinity;
  yMax = -Infinity;
  /**
   * Indicates that some sample point could not be transformed.
   */
  invalid = false;
  numValid = 0;

  reset() {
    this.xMin = this.yMin = Infinity;
    this.xMax = this.yMax = -Infinity;
    this.invalid = false;
    this.numValid = 0;
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
    ++this.numValid;
    this.xMin = Math.min(this.xMin, cx);
    this.xMax = Math.max(this.xMax, cx);
    this.yMin = Math.min(this.yMin, cy);
    this.yMax = Math.max(this.yMax, cy);
  }

  /**
   * Tests whether the bounds, expanded by `marginFraction` of their size and shifted by
   * `(offsetX, offsetY)`, intersect the viewport `[-1, 1]^2`.
   *
   * If some sample points are invalid, the bounds of the valid points are expanded by a larger
   * margin.  If no sample points are valid, the result is `!isLeaf`, such that blocks of chunks
   * are subdivided further while single chunks are considered not visible.
   */
  intersectsViewport(
    offsetX: number,
    offsetY: number,
    marginFraction: number,
    isLeaf = false,
  ) {
    if (this.numValid === 0) return !isLeaf;
    if (this.invalid) marginFraction = Math.max(marginFraction, 0.5);
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
 * Footprints are represented by their support function `h(d) = max_p d . p` sampled at
 * `FOOTPRINT_NUM_DIRECTIONS` unit directions `d` spaced 45 degrees apart (i.e. as an 8-DOP), which
 * allows the clip-space bounds to be computed conservatively, and exactly if the view is aligned
 * with the warped axes, for any affine view transform.
 *
 * Layout of a footprint record: `[h_0, ..., h_7, numValid, invalid]`.
 */
const FOOTPRINT_NUM_DIRECTIONS = 8;
const FOOTPRINT_RECORD_SIZE = FOOTPRINT_NUM_DIRECTIONS + 2;
const FOOTPRINT_DIRECTION_X = Float64Array.of(
  1,
  Math.SQRT1_2,
  0,
  -Math.SQRT1_2,
  -1,
  -Math.SQRT1_2,
  0,
  Math.SQRT1_2,
);
const FOOTPRINT_DIRECTION_Y = Float64Array.of(
  0,
  Math.SQRT1_2,
  1,
  Math.SQRT1_2,
  0,
  -Math.SQRT1_2,
  -1,
  -Math.SQRT1_2,
);

/**
 * Computes the footprint record of the image of the rectangle `[x0, x1] x [y0, y1]` (true chunk
 * coordinates of the warped dimensions) by sampling its boundary.  If some boundary points are
 * invalid, interior points are sampled as well.
 */
function computeFootprint(
  geo: GeoTransformedSourceInfo,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Float64Array {
  const record = new Float64Array(FOOTPRINT_RECORD_SIZE);
  record.fill(-Infinity, 0, FOOTPRINT_NUM_DIRECTIONS);
  const { warp } = geo;
  let numValid = 0;
  let invalid = false;
  const addPoint = (x: number, y: number) => {
    if (warp.forward(x, y, tempWarped) === TransformStatus.INVALID) {
      invalid = true;
      return;
    }
    const wx = tempWarped[0];
    const wy = tempWarped[1];
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
      invalid = true;
      return;
    }
    ++numValid;
    for (let k = 0; k < FOOTPRINT_NUM_DIRECTIONS; ++k) {
      const h = FOOTPRINT_DIRECTION_X[k] * wx + FOOTPRINT_DIRECTION_Y[k] * wy;
      if (h > record[k]) record[k] = h;
    }
  };
  const n = FOOTPRINT_SAMPLES_PER_EDGE;
  for (let i = 0; i < n; ++i) {
    const t = i / n;
    addPoint(x0 + t * (x1 - x0), y0);
    addPoint(x1, y0 + t * (y1 - y0));
    addPoint(x1 - t * (x1 - x0), y1);
    addPoint(x0, y1 - t * (y1 - y0));
  }
  if (invalid) {
    for (let i = 1; i < n; ++i) {
      for (let j = 1; j < n; ++j) {
        addPoint(x0 + (i / n) * (x1 - x0), y0 + (j / n) * (y1 - y0));
      }
    }
  }
  record[FOOTPRINT_NUM_DIRECTIONS] = numValid;
  record[FOOTPRINT_NUM_DIRECTIONS + 1] = invalid ? 1 : 0;
  return record;
}

/**
 * Returns an upper bound on `max_p (a, b) . p` over the footprint represented by `record`.
 */
function evaluateFootprintSupport(record: Float64Array, a: number, b: number) {
  if (a === 0 && b === 0) return 0;
  let angle = Math.atan2(b, a);
  if (angle < 0) angle += 2 * Math.PI;
  const k = Math.floor(angle / (Math.PI / 4)) % FOOTPRINT_NUM_DIRECTIONS;
  const k1 = (k + 1) % FOOTPRINT_NUM_DIRECTIONS;
  // Decompose `(a, b) = alpha * d_k + beta * d_k1` with `alpha, beta >= 0`.
  const xk = FOOTPRINT_DIRECTION_X[k];
  const yk = FOOTPRINT_DIRECTION_Y[k];
  const xk1 = FOOTPRINT_DIRECTION_X[k1];
  const yk1 = FOOTPRINT_DIRECTION_Y[k1];
  const det = xk * yk1 - yk * xk1;
  const alpha = (a * yk1 - b * xk1) / det;
  const beta = (xk * b - yk * a) / det;
  let result = 0;
  if (alpha !== 0) result += alpha * record[k];
  if (beta !== 0) result += beta * record[k1];
  return result;
}

const tempBounds = new ClipBounds();
const tempPositionInChunks = vec3.create();

/**
 * Sets `bounds` to the clip-space bounds of the footprint represented by `record`.  Assumes that
 * the view transform is affine (as is the case for cross-section views).
 */
function setClipBoundsFromFootprint(
  bounds: ClipBounds,
  record: Float64Array,
  view: GeoViewParameters,
) {
  bounds.reset();
  const numValid = record[FOOTPRINT_NUM_DIRECTIONS];
  bounds.numValid = numValid;
  bounds.invalid = record[FOOTPRINT_NUM_DIRECTIONS + 1] !== 0;
  if (numValid === 0) return;
  const { si, sj, sk, subspaceToClip: m, thirdCoordinate: z } = view;
  const w = m[sk * 4 + 3] * z + m[15];
  for (let row = 0; row < 2; ++row) {
    const a = m[si * 4 + row];
    const b = m[sj * 4 + row];
    const c = m[sk * 4 + row] * z + m[12 + row];
    let upper = (evaluateFootprintSupport(record, a, b) + c) / w;
    let lower = (c - evaluateFootprintSupport(record, -a, -b)) / w;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      bounds.numValid = 0;
      bounds.invalid = true;
      return;
    }
    if (lower > upper) {
      const t = lower;
      lower = upper;
      upper = t;
    }
    if (row === 0) {
      bounds.xMin = lower;
      bounds.xMax = upper;
    } else {
      bounds.yMin = lower;
      bounds.yMax = upper;
    }
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
  if (worldPeriodSubspace === undefined || bounds.numValid === 0) {
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

/**
 * Maximum number of visible chunks of a single warped source.  Strongly anisotropic warps can make
 * an enormous number of chunks of a single resolution visible at once, e.g. near a pole of a
 * polar display CRS, where a small region covers all longitudes of a source in geographic
 * coordinates.  Beyond this limit, the source is skipped, such that coarser resolutions are shown
 * instead.
 */
export const MAX_GEO_VISIBLE_CHUNKS = 4096;

/**
 * Maximum depth of the block subdivision in `forEachGeoVisibleChunk`, used to form cache keys.
 */
const MAX_FOOTPRINT_DEPTH = 256;

/**
 * Invokes `callback` for each visible chunk of a warped source.  Each chunk is reported once, even
 * if multiple world copies are visible, along with the distance in pixels between the center of
 * the view and the center of the (nearest visible copy of the) chunk footprint.
 *
 * The footprints of the blocks of chunks visited are cached in `tsource.geo` and reused across
 * calls, such that the warp is only evaluated for blocks not visited previously.
 *
 * If more than `MAX_GEO_VISIBLE_CHUNKS` chunks are visible, no chunks are reported.
 */
export function forEachGeoVisibleChunk<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(
  projectionParameters: ProjectionParameters,
  localPosition: Float32Array,
  tsource: TransformedSource<RLayer>,
  chunkLayout: ChunkLayout,
  callback: (positionInChunks: vec3, screenDistance: number) => void,
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
  const numY = upperY - lowerY;

  const { levelGroup, levelIndex } = geo;
  if (levelGroup !== undefined) {
    const planEntry = getGeoLevelPlan(levelGroup, projectionParameters);
    if (planEntry !== undefined) {
      const level = planEntry.inputs[levelIndex!];
      const positionInChunks = tempPositionInChunks;
      positionInChunks[sk] = chunkK;
      const chunkDimX = chunkDisplayDimensionIndices[si];
      const chunkDimY = chunkDisplayDimensionIndices[sj];
      const chunkDimK = chunkDisplayDimensionIndices[sk];
      for (const [key, distance] of planEntry.plan.chunks[levelIndex!]) {
        const [x, y] = geoLevelChunkFromKey(level, key);
        positionInChunks[si] = x;
        positionInChunks[sj] = y;
        curPositionInChunks[chunkDimX] = x;
        curPositionInChunks[chunkDimY] = y;
        curPositionInChunks[chunkDimK] = chunkK;
        callback(positionInChunks, distance);
      }
      return;
    }
  }

  // Footprint cache.
  let nodes: Map<number, Float64Array>;
  {
    const key = `${clipX0},${clipY0},${clipX1},${clipY1},${sizeX},${sizeY},${lowerX},${lowerY},${upperX},${upperY}`;
    let cache = geo.footprintCache;
    if (cache === undefined || cache.key !== key) {
      cache = geo.footprintCache = { key, nodes: new Map() };
    } else if (cache.nodes.size > MAX_CACHED_FOOTPRINTS) {
      cache.nodes.clear();
    }
    nodes = cache.nodes;
  }
  const bounds = tempBounds;
  const getBlockClipBounds = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    depth: number,
  ) => {
    const key =
      ((x0 - lowerX) * numY + (y0 - lowerY)) * MAX_FOOTPRINT_DEPTH + depth;
    let record = nodes.get(key);
    if (record === undefined) {
      record = computeFootprint(
        geo,
        Math.max(clipX0, x0 * sizeX),
        Math.max(clipY0, y0 * sizeY),
        Math.min(clipX1, x1 * sizeX),
        Math.min(clipY1, y1 * sizeY),
      );
      nodes.set(key, record);
    }
    setClipBoundsFromFootprint(bounds, record, view);
  };

  getBlockClipBounds(lowerX, lowerY, upperX, upperY, 0);
  const copies = getWorldCopyOffsets(bounds, view, 0.1);
  if (copies.length === 0) return;

  // Map from chunk index to the minimum screen distance over the visible copies.
  const visible = new Map<number, number>();
  const halfWidth = projectionParameters.width / 2;
  const halfHeight = projectionParameters.height / 2;

  let tooManyChunks = false;
  for (let copyIndex = 0; copyIndex < copies.length; copyIndex += 3) {
    const offsetX = copies[copyIndex + 1];
    const offsetY = copies[copyIndex + 2];
    const recurse = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      depth: number,
    ) => {
      if (tooManyChunks) return;
      getBlockClipBounds(x0, y0, x1, y1, depth);
      const nx = x1 - x0;
      const ny = y1 - y0;
      const isLeaf = nx === 1 && ny === 1;
      if (!bounds.intersectsViewport(offsetX, offsetY, 0.1, isLeaf)) {
        return;
      }
      if (isLeaf) {
        const key = (x0 - lowerX) * numY + (y0 - lowerY);
        const dx = (0.5 * (bounds.xMin + bounds.xMax) + offsetX) * halfWidth;
        const dy = (0.5 * (bounds.yMin + bounds.yMax) + offsetY) * halfHeight;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const prev = visible.get(key);
        if (prev === undefined || distance < prev) visible.set(key, distance);
        if (visible.size > MAX_GEO_VISIBLE_CHUNKS) tooManyChunks = true;
        return;
      }
      if (nx >= ny) {
        const mid = x0 + Math.floor(nx / 2);
        recurse(x0, y0, mid, y1, depth + 1);
        recurse(mid, y0, x1, y1, depth + 1);
      } else {
        const mid = y0 + Math.floor(ny / 2);
        recurse(x0, y0, x1, mid, depth + 1);
        recurse(x0, mid, x1, y1, depth + 1);
      }
    };
    recurse(lowerX, lowerY, upperX, upperY, 0);
  }
  if (tooManyChunks) return;

  const positionInChunks = tempPositionInChunks;
  positionInChunks[sk] = chunkK;
  const chunkDimX = chunkDisplayDimensionIndices[si];
  const chunkDimY = chunkDisplayDimensionIndices[sj];
  const chunkDimK = chunkDisplayDimensionIndices[sk];
  for (const [key, distance] of visible) {
    const y = lowerY + (key % numY);
    const x = lowerX + (key - (key % numY)) / numY;
    positionInChunks[si] = x;
    positionInChunks[sj] = y;
    curPositionInChunks[chunkDimX] = x;
    curPositionInChunks[chunkDimY] = y;
    curPositionInChunks[chunkDimK] = chunkK;
    callback(positionInChunks, distance);
  }
}

function composeAffine2d(a: Affine2d, b: Affine2d): Affine2d {
  // Returns `a ∘ b`.
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const geoLevelGroups = new WeakMap<
  readonly TransformedSource<any>[],
  GeoLevelGroup
>();

/**
 * Number of cached level plans per group, e.g. for multiple views of the same sources.
 */
const MAX_CACHED_LEVEL_PLANS = 4;

/**
 * Prepares the resolution levels `sources` (from finest to coarsest) of a layer for joint
 * selection of visible chunks, if they are warped sources rendered using the warped path in the
 * current view.  Returns `true` in that case, in which case all levels should be considered
 * visible (the visible chunks of each level are then determined by `forEachGeoVisibleChunk`).
 */
export function prepareGeoLevelGroup(
  sources: readonly TransformedSource<any>[],
  projectionParameters: ProjectionParameters,
  getChunkLayout: (tsource: TransformedSource<any>) => ChunkLayout,
): boolean {
  const applicable =
    sources.length > 0 &&
    sources.every(
      (tsource) =>
        tsource.geo !== undefined &&
        tsource.geo.warp.multiscaleWarp ===
          sources[0].geo!.warp.multiscaleWarp &&
        getGeoRenderingMode(
          tsource,
          projectionParameters,
          getChunkLayout(tsource),
        ) === GeoRenderingMode.WARPED,
    );
  if (!applicable) {
    for (const tsource of sources) {
      if (tsource.geo !== undefined) {
        tsource.geo.levelGroup = undefined;
        tsource.geo.levelIndex = undefined;
      }
    }
    return false;
  }
  let group = geoLevelGroups.get(sources);
  if (group === undefined) {
    group = { sources, planCache: [] };
    geoLevelGroups.set(sources, group);
  }
  sources.forEach((tsource, i) => {
    tsource.geo!.levelGroup = group;
    tsource.geo!.levelIndex = i;
  });
  return true;
}

const tempScreenSubspace = new Float64Array(2);

/**
 * Returns the (cached) plan of visible chunks of each level of `group` for the current view, or
 * `undefined` if the levels cannot be displayed in the current view.
 */
function getGeoLevelPlan(
  group: GeoLevelGroup,
  projectionParameters: ProjectionParameters,
) {
  const { sources } = group;
  const tsource0 = sources[0];
  const renderScaleTarget =
    (tsource0.renderLayer as any)?.renderScaleTarget?.value ?? 1;
  const { width, height, viewProjectionMat } = projectionParameters;
  const key = new Float64Array(19);
  key.set(viewProjectionMat);
  key[16] = width;
  key[17] = height;
  key[18] = renderScaleTarget;
  const { planCache } = group;
  for (let i = 0; i < planCache.length; ++i) {
    const entry = planCache[i];
    if (entry.key.every((v, j) => v === key[j])) {
      // Move to the front.
      planCache.splice(i, 1);
      planCache.unshift(entry);
      return entry;
    }
  }
  const inputs: GeoLevelInput[] = [];
  let view0: GeoViewParameters | undefined;
  for (const tsource of sources) {
    const geo = tsource.geo!;
    const chunkLayout = getNormalizedChunkLayout(
      projectionParameters,
      tsource.chunkLayout,
    );
    const view = getGeoViewParameters(geo, projectionParameters, chunkLayout);
    if (view === undefined) return undefined;
    view0 ??= view;
    const { si, sj } = view;
    const { size } = chunkLayout;
    inputs.push({
      fromLevel0: composeAffine2d(
        geo.warp.multiscaleToChunk,
        tsource0.geo!.warp.chunkToMultiscale,
      ),
      chunkSizeX: size[si],
      chunkSizeY: size[sj],
      lowerChunkX: tsource.lowerChunkDisplayBound[si],
      lowerChunkY: tsource.lowerChunkDisplayBound[sj],
      upperChunkX: tsource.upperChunkDisplayBound[si],
      upperChunkY: tsource.upperChunkDisplayBound[sj],
    });
  }
  const { si, sj, sk, subspaceToClip: m, thirdCoordinate: z } = view0!;
  const a = m[si * 4];
  const b = m[sj * 4];
  const c = m[sk * 4] * z + m[12];
  const d = m[si * 4 + 1];
  const e = m[sj * 4 + 1];
  const f = m[sk * 4 + 1] * z + m[13];
  const w = m[sk * 4 + 3] * z + m[15];
  const det = a * e - b * d;
  const warp = tsource0.geo!.warp;
  const { worldPeriod, isIdentity } = warp;
  const maxCopy = worldPeriod === undefined ? 0 : MAX_WORLD_COPIES;
  const lowerX = tsource0.lowerClipDisplayBound[si];
  const lowerY = tsource0.lowerClipDisplayBound[sj];
  const upperX = tsource0.upperClipDisplayBound[si];
  const upperY = tsource0.upperClipDisplayBound[sj];
  const screenToSource = (px: number, py: number, out: Float64Array) => {
    const cx = (2 * px) / width - 1;
    const cy = 1 - (2 * py) / height;
    const rx = cx * w - c;
    const ry = cy * w - f;
    const vx = (rx * e - b * ry) / det;
    const vy = (a * ry - d * rx) / det;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return undefined;
    for (let i = 0; i <= 2 * maxCopy; ++i) {
      // k = 0, -1, 1, -2, 2, ...
      const k = i & 1 ? -((i + 1) >> 1) : i >> 1;
      let qx = vx;
      let qy = vy;
      if (k !== 0) {
        qx -= k * worldPeriod![0];
        qy -= k * worldPeriod![1];
      }
      let tx = qx;
      let ty = qy;
      if (!isIdentity) {
        if (
          warp.inverse(qx, qy, tempScreenSubspace) === TransformStatus.INVALID
        ) {
          continue;
        }
        tx = tempScreenSubspace[0];
        ty = tempScreenSubspace[1];
      }
      if (!(tx >= lowerX && tx <= upperX && ty >= lowerY && ty <= upperY)) {
        continue;
      }
      if (
        !isIdentity &&
        (warp.forward(tx, ty, tempScreenSubspace) === TransformStatus.INVALID ||
          Math.abs(tempScreenSubspace[0] - qx) > ROUND_TRIP_TOLERANCE ||
          Math.abs(tempScreenSubspace[1] - qy) > ROUND_TRIP_TOLERANCE)
      ) {
        continue;
      }
      out[0] = tx;
      out[1] = ty;
      return k;
    }
    return undefined;
  };
  const plan = computeGeoLevelPlan({
    levels: inputs,
    width,
    height,
    screenToSource,
    renderScaleTarget,
  });
  const entry = { key, plan, inputs };
  planCache.unshift(entry);
  if (planCache.length > MAX_CACHED_LEVEL_PLANS) planCache.pop();
  return entry;
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
 * Marks the start of a new frame for the mesh cache of a source.  Meshes used in the current or
 * previous frame are never evicted.
 */
export function beginGeoMeshFrame(tsource: TransformedSource<any>) {
  const geo = tsource.geo!;
  let cache = geo.meshCache;
  if (cache === undefined) {
    cache = geo.meshCache = new GeoMeshCache();
  }
  ++cache.generation;
  cache.previousFrameCount = cache.currentFrameCount;
  cache.currentFrameCount = 0;
}

/**
 * Maximum time in milliseconds spent computing new chunk meshes of a single source per frame.
 * Chunks whose meshes would exceed the budget are drawn in subsequent frames, which keeps the
 * viewer responsive when many new chunks become visible at once.
 */
export const GEO_MESH_BUILD_BUDGET_MS = 12;

/**
 * Returns the (cached) mesh for a chunk.  If the mesh is not cached and `allowCompute` is `false`,
 * returns `undefined`.
 */
export function getGeoChunkMesh(
  tsource: TransformedSource<any>,
  chunkLayout: ChunkLayout,
  key: string,
  gridX: number,
  gridY: number,
  si: number,
  sj: number,
  allowCompute = true,
): GeoChunkMesh | undefined {
  const geo = tsource.geo!;
  let cache = geo.meshCache;
  if (cache === undefined) {
    cache = geo.meshCache = new GeoMeshCache();
  }
  const { meshes, generation } = cache;
  let mesh = meshes.get(key);
  if (mesh !== undefined) {
    // Move to the end to maintain LRU order.
    meshes.delete(key);
    meshes.set(key, mesh);
  } else {
    if (!allowCompute) return undefined;
    mesh = computeGeoChunkMesh(tsource, chunkLayout, gridX, gridY, si, sj);
    meshes.set(key, mesh);
    cache.totalVertices += mesh.numVertices;
  }
  if (mesh.generation !== generation) {
    mesh.generation = generation;
    ++cache.currentFrameCount;
  }
  const maxMeshes = Math.max(
    MIN_CACHED_MESHES,
    MESH_CACHE_FRAME_MULTIPLIER * cache.previousFrameCount,
  );
  while (
    meshes.size > maxMeshes ||
    cache.totalVertices > MAX_CACHED_MESH_VERTICES
  ) {
    const [oldestKey, oldest] = meshes.entries().next().value!;
    // Meshes are in LRU order, so if the oldest mesh was used in the current or previous frame,
    // all of them were.
    if (oldest.generation! >= generation - 1) break;
    oldest.gpuMesh?.dispose();
    meshes.delete(oldestKey);
    cache.totalVertices -= oldest.numVertices;
  }
  return mesh;
}

/**
 * Releases the cached chunk meshes (and their GPU resources) of a transformed source.
 */
export function disposeGeoMeshCache(tsource: TransformedSource<any>) {
  const cache = tsource.geo?.meshCache;
  if (cache === undefined) return;
  for (const mesh of cache.meshes.values()) {
    mesh.gpuMesh?.dispose();
  }
  cache.meshes.clear();
  cache.totalVertices = 0;
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
 * Maximum distance, in voxels, between a position and the result of mapping it through the inverse
 * and forward warp for it to be considered to be within the image of the warp.
 */
const ROUND_TRIP_TOLERANCE = 1;

/**
 * Converts approximate chunk coordinates (as computed from the affine chunk transform) of the
 * warped dimensions in `chunkPosition` to true chunk coordinates.
 *
 * If the warp has a world period, the position may be within a world copy of the source rather than
 * the canonical copy.  The position shifted by each multiple of the world period (starting with the
 * unshifted position) is tried, and the first one that is in the image of the warp and whose true
 * chunk coordinates are within `[lowerBound, upperBound)` is chosen.
 *
 * Returns `false` if there is no such position.
 */
export function correctGeoChunkPosition(
  warp: ChunkGeoWarp,
  chunkPosition: Float32Array,
  lowerBound: ArrayLike<number>,
  upperBound: ArrayLike<number>,
): boolean {
  const [d0, d1] = warp.chunkDimensions;
  const x = chunkPosition[d0];
  const y = chunkPosition[d1];
  const { worldPeriod, isIdentity } = warp;
  const maxCopy = worldPeriod === undefined ? 0 : MAX_WORLD_COPIES;
  const lower0 = lowerBound[d0];
  const lower1 = lowerBound[d1];
  const upper0 = upperBound[d0];
  const upper1 = upperBound[d1];
  for (let i = 0; i <= 2 * maxCopy; ++i) {
    // k = 0, -1, 1, -2, 2, ...
    const k = i & 1 ? -((i + 1) >> 1) : i >> 1;
    let px = x;
    let py = y;
    if (k !== 0) {
      px -= k * worldPeriod![0];
      py -= k * worldPeriod![1];
    }
    let tx = px;
    let ty = py;
    if (!isIdentity) {
      if (warp.inverse(px, py, tempWarped) === TransformStatus.INVALID) {
        continue;
      }
      tx = tempWarped[0];
      ty = tempWarped[1];
      if (!(tx >= lower0 && tx < upper0 && ty >= lower1 && ty < upper1)) {
        continue;
      }
      // The inverse may map a position outside the canonical copy to the source (e.g. if
      // longitudes are wrapped), in which case the forward warp does not return to it.
      if (
        warp.forward(tx, ty, tempWarped) === TransformStatus.INVALID ||
        Math.abs(tempWarped[0] - px) > ROUND_TRIP_TOLERANCE ||
        Math.abs(tempWarped[1] - py) > ROUND_TRIP_TOLERANCE
      ) {
        continue;
      }
    } else if (!(tx >= lower0 && tx < upper0 && ty >= lower1 && ty < upper1)) {
      continue;
    }
    chunkPosition[d0] = tx;
    chunkPosition[d1] = ty;
    return true;
  }
  return false;
}
