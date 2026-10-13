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
 * @file Display of georeferenced volume sources (e.g. map tiles) on the 3-d globe of the
 * perspective panel (see `src/geo/globe.ts`), shared by the frontend (drawing) and the backend
 * (requesting chunks).
 *
 * Each chunk of the two georeferenced dimensions is a tile, drawn as a grid mesh on the ellipsoid.
 * The tiles to show are selected by `selectGlobeTiles` from all resolution levels jointly.
 */

import { getCrs } from "#src/geo/crs.js";
import {
  geodeticToEcef,
  getGlobePixelAngle,
  splitDouble,
  WGS84_SEMI_MAJOR_AXIS,
} from "#src/geo/globe.js";
import type {
  GlobeTile,
  GlobeTileLevel,
  GlobeTileView,
  SelectGlobeTilesOptions,
} from "#src/geo/globe_tiles.js";
import {
  GlobeTileFootprintCache,
  selectGlobeTiles,
} from "#src/geo/globe_tiles.js";
import type { Affine2d } from "#src/geo/source_warp.js";
import { applyAffine2d } from "#src/geo/source_warp.js";
import { GeographicTransform, TransformStatus } from "#src/geo/transform.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import type { TransformedSource } from "#src/sliceview/base.js";

export const GLOBE_VOLUME_RENDER_LAYER_RPC_ID =
  "sliceview/GlobeVolumeRenderLayer";
export const GLOBE_VOLUME_RENDER_LAYER_UPDATE_SOURCES_RPC_ID =
  "sliceview/GlobeVolumeRenderLayer/update";

/**
 * Maximum number of screen pixels covered by a texel, for `renderScaleTarget = 1`.
 */
const GLOBE_PIXELS_PER_TEXEL = 1.5;

/**
 * Maximum number of tiles selected per source.
 */
export const MAX_GLOBE_TILES = 1024;

/**
 * Composes 2-d affine transforms: returns `a ∘ b`.
 */
function composeAffine2d(a: Affine2d, b: Affine2d): Affine2d {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * The resolution levels of a georeferenced multiscale source shown on the globe.
 */
export interface GlobeSourceLevels<
  T extends TransformedSource<any, any> = TransformedSource<any, any>,
> {
  /**
   * Transformed sources, from finest to coarsest.
   */
  sources: T[];
  levels: GlobeTileLevel[];
  footprintCache: GlobeTileFootprintCache;
}

const levelsCache = new WeakMap<object, GlobeSourceLevels>();

function makeGlobeTileLevel(
  tsource: TransformedSource<any, any>,
  toLevel0: Affine2d,
  fromLevel0: Affine2d,
): GlobeTileLevel {
  const geo = tsource.geo!;
  const [cd0, cd1] = geo.chunkDimensions;
  const { spec } = tsource.source;
  const chunkToSource = composeAffine2d(
    geo.spec.multiscaleToSource,
    geo.warp.chunkToMultiscale,
  );
  const geographic = new GeographicTransform(
    getCrs(geo.spec.sourceCrs),
    geo.spec.referenceLongitude,
  );
  const temp = new Float64Array(2);
  return {
    tileSize: [spec.chunkDataSize[cd0], spec.chunkDataSize[cd1]],
    lowerTile: [spec.lowerChunkBound[cd0], spec.lowerChunkBound[cd1]],
    upperTile: [spec.upperChunkBound[cd0], spec.upperChunkBound[cd1]],
    lowerVoxel: [spec.lowerVoxelBound[cd0], spec.lowerVoxelBound[cd1]],
    upperVoxel: [spec.upperVoxelBound[cd0], spec.upperVoxelBound[cd1]],
    toLevel0,
    fromLevel0,
    toLonLat(x, y, out) {
      applyAffine2d(chunkToSource, x, y, temp);
      return (
        geographic.toLonLat(temp[0], temp[1], out) !== TransformStatus.INVALID
      );
    },
  };
}

/**
 * Returns the georeferenced resolution levels of a multiscale source (ordered from finest to
 * coarsest), or `undefined` if the source is not georeferenced.  The result is cached for the
 * array of transformed sources.
 */
export function getGlobeSourceLevels<T extends TransformedSource<any, any>>(
  scales: T[],
): GlobeSourceLevels<T> | undefined {
  let result = levelsCache.get(scales) as GlobeSourceLevels<T> | undefined;
  if (result !== undefined) return result;
  const sources = scales.filter(
    (tsource) =>
      tsource.geo !== undefined &&
      tsource.geo.chunkDimensions[0] === scales[0].geo?.chunkDimensions[0] &&
      tsource.geo.chunkDimensions[1] === scales[0].geo?.chunkDimensions[1],
  );
  if (sources.length === 0) return undefined;
  const base = sources[0].geo!.warp;
  const levels = sources.map((tsource) => {
    const { warp } = tsource.geo!;
    return makeGlobeTileLevel(
      tsource,
      composeAffine2d(base.multiscaleToChunk, warp.chunkToMultiscale),
      composeAffine2d(warp.multiscaleToChunk, base.chunkToMultiscale),
    );
  });
  result = { sources, levels, footprintCache: new GlobeTileFootprintCache() };
  levelsCache.set(scales, result);
  return result;
}

/**
 * Returns the view parameters for tile selection, or `undefined` if the projection parameters are
 * not those of the globe view.
 */
export function getGlobeTileView(
  projectionParameters: ProjectionParameters,
): GlobeTileView | undefined {
  const { globeTarget: target, invViewMatrix } = projectionParameters;
  if (target === undefined) return undefined;
  const eye = Float64Array.of(
    target[0] + invViewMatrix[12],
    target[1] + invViewMatrix[13],
    target[2] + invViewMatrix[14],
  );
  return {
    eye,
    target,
    viewProjectionMat: projectionParameters.viewProjectionMat,
    pixelAngle: getGlobePixelAngle(projectionParameters.logicalHeight),
  };
}

/**
 * Selects the tiles of a georeferenced multiscale source to show on the globe.  Tile levels index
 * `GlobeSourceLevels.sources`.
 */
export function selectGlobeSourceTiles(
  sourceLevels: GlobeSourceLevels,
  view: GlobeTileView,
  renderScaleTarget: number,
): GlobeTile[] {
  const options: SelectGlobeTilesOptions = {
    maxPixelsPerTexel:
      GLOBE_PIXELS_PER_TEXEL * Math.max(0.25, renderScaleTarget),
    maxTiles: MAX_GLOBE_TILES,
  };
  return selectGlobeTiles(
    sourceLevels.levels,
    view,
    sourceLevels.footprintCache,
    options,
  );
}

/**
 * Sets the chunk grid position of `tsource.curPositionInChunks` along the georeferenced dimensions
 * to the specified tile.
 */
export function setGlobeTilePosition(
  tsource: TransformedSource<any, any>,
  x: number,
  y: number,
) {
  const [cd0, cd1] = tsource.geo!.chunkDimensions;
  tsource.curPositionInChunks[cd0] = x;
  tsource.curPositionInChunks[cd1] = y;
}

/**
 * Number of mesh segments per edge of a tile per radian of its extent on the globe, and the limits.
 */
const SEGMENTS_PER_RADIAN = 90;
const MIN_TILE_SEGMENTS = 8;
const MAX_TILE_SEGMENTS = 64;

/**
 * Mesh of a tile on the ellipsoid.
 */
export interface GlobeTileMesh {
  /**
   * ECEF coordinates of the origin of the mesh.
   */
  origin: Float64Array;
  /**
   * ECEF coordinates of the vertices relative to `origin`, split into high and low parts.
   */
  positionHigh: Float32Array;
  positionLow: Float32Array;
  /**
   * Position of each vertex within the chunk, in voxels, along the two georeferenced dimensions.
   */
  chunkPosition: Float32Array;
  /**
   * Triangle indices, wound counter-clockwise as seen from outside the ellipsoid.
   */
  indices: Uint32Array;
}

/**
 * Minimum number of mesh segments per edge of a tile with terrain.
 */
const MIN_TERRAIN_TILE_SEGMENTS = 32;

/**
 * Depth of the skirts of tile meshes with terrain, as a multiple of the spacing of the vertices.
 */
const SKIRT_DEPTH_FACTOR = 2;

/**
 * Computes the mesh of a tile: a grid over the voxel extent of the tile, mapped to the ellipsoid.
 * Grid cells with vertices that cannot be mapped to geodetic coordinates are omitted.
 *
 * @param getHeight If specified, returns the height above the ellipsoid of each vertex, given its
 *     geodetic coordinates and the approximate spacing of the vertices in meters.  The mesh then
 *     has a skirt: walls hanging from the edges of the tile, which hide cracks between adjacent
 *     tiles whose heights are sampled at different vertices.
 */
export function computeGlobeTileMesh(
  level: GlobeTileLevel,
  x: number,
  y: number,
  angularExtent: number,
  getHeight?: (lon: number, lat: number, spacing: number) => number,
): GlobeTileMesh {
  const n = Math.min(
    MAX_TILE_SEGMENTS,
    Math.max(
      getHeight === undefined ? MIN_TILE_SEGMENTS : MIN_TERRAIN_TILE_SEGMENTS,
      Math.ceil(angularExtent * SEGMENTS_PER_RADIAN),
    ),
  );
  const spacing = (angularExtent * WGS84_SEMI_MAJOR_AXIS) / n;
  const [sx, sy] = level.tileSize;
  const x0 = Math.max(level.lowerVoxel[0], x * sx);
  const y0 = Math.max(level.lowerVoxel[1], y * sy);
  const x1 = Math.min(level.upperVoxel[0], (x + 1) * sx);
  const y1 = Math.min(level.upperVoxel[1], (y + 1) * sy);
  const numGridVertices = (n + 1) * (n + 1);
  // Grid vertices on the boundary, in order around the tile.
  const boundary: number[] = [];
  if (getHeight !== undefined) {
    for (let i = 0; i < n; ++i) boundary.push(i);
    for (let j = 0; j < n; ++j) boundary.push(j * (n + 1) + n);
    for (let i = n; i > 0; --i) boundary.push(n * (n + 1) + i);
    for (let j = n; j > 0; --j) boundary.push(j * (n + 1));
  }
  const numVertices = numGridVertices + boundary.length;
  const ecef = new Float64Array(numVertices * 3);
  // Positions on the ellipsoid, which determine the orientation of the triangles.
  const flat =
    getHeight === undefined ? ecef : new Float64Array(numVertices * 3);
  const valid = new Uint8Array(numVertices);
  const chunkPosition = new Float32Array(numVertices * 2);
  const lonLats = new Float64Array(numGridVertices * 2);
  const heights = new Float64Array(numGridVertices);
  const lonLat = new Float64Array(2);
  const origin = new Float64Array(3);
  let haveOrigin = false;
  for (let j = 0; j <= n; ++j) {
    for (let i = 0; i <= n; ++i) {
      const v = j * (n + 1) + i;
      const vx = x0 + ((x1 - x0) * i) / n;
      const vy = y0 + ((y1 - y0) * j) / n;
      chunkPosition[2 * v] = vx - x * sx;
      chunkPosition[2 * v + 1] = vy - y * sy;
      if (!level.toLonLat(vx, vy, lonLat)) continue;
      const height =
        getHeight === undefined ? 0 : getHeight(lonLat[0], lonLat[1], spacing);
      lonLats[2 * v] = lonLat[0];
      lonLats[2 * v + 1] = lonLat[1];
      heights[v] = height;
      geodeticToEcef(lonLat[0], lonLat[1], height, ecef, 3 * v);
      if (flat !== ecef) geodeticToEcef(lonLat[0], lonLat[1], 0, flat, 3 * v);
      valid[v] = 1;
      if (!haveOrigin) {
        origin.set(ecef.subarray(3 * v, 3 * v + 3));
        haveOrigin = true;
      }
    }
  }
  // Skirt vertices, below the boundary vertices.
  const skirtDepth = SKIRT_DEPTH_FACTOR * spacing;
  for (let k = 0; k < boundary.length; ++k) {
    const v = boundary[k];
    if (!valid[v]) continue;
    const s = numGridVertices + k;
    geodeticToEcef(
      lonLats[2 * v],
      lonLats[2 * v + 1],
      heights[v] - skirtDepth,
      ecef,
      3 * s,
    );
    chunkPosition[2 * s] = chunkPosition[2 * v];
    chunkPosition[2 * s + 1] = chunkPosition[2 * v + 1];
    valid[s] = 1;
  }
  const relative = new Float64Array(numVertices * 3);
  for (let v = 0; v < numVertices; ++v) {
    if (!valid[v]) continue;
    for (let k = 0; k < 3; ++k) {
      relative[3 * v + k] = ecef[3 * v + k] - origin[k];
    }
  }
  const positionHigh = new Float32Array(numVertices * 3);
  const positionLow = new Float32Array(numVertices * 3);
  splitDouble(relative, positionHigh, positionLow);
  const indices: number[] = [];
  const addTriangle = (a: number, b: number, c: number) => {
    if (!valid[a] || !valid[b] || !valid[c]) return;
    // Orient the triangle such that its normal on the ellipsoid points away from the center of
    // the Earth.
    const ax = flat[3 * a];
    const ay = flat[3 * a + 1];
    const az = flat[3 * a + 2];
    const ux = flat[3 * b] - ax;
    const uy = flat[3 * b + 1] - ay;
    const uz = flat[3 * b + 2] - az;
    const wx = flat[3 * c] - ax;
    const wy = flat[3 * c + 1] - ay;
    const wz = flat[3 * c + 2] - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const d = nx * ax + ny * ay + nz * az;
    if (d === 0) return;
    if (d > 0) {
      indices.push(a, b, c);
    } else {
      indices.push(a, c, b);
    }
  };
  for (let j = 0; j < n; ++j) {
    for (let i = 0; i < n; ++i) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      addTriangle(a, b, d);
      addTriangle(a, d, c);
    }
  }
  // The skirt walls are vertical, and visible from both sides.
  for (let k = 0; k < boundary.length; ++k) {
    const k1 = (k + 1) % boundary.length;
    const a = boundary[k];
    const b = boundary[k1];
    const sa = numGridVertices + k;
    const sb = numGridVertices + k1;
    if (!valid[a] || !valid[b] || !valid[sa] || !valid[sb]) continue;
    indices.push(a, b, sb, a, sb, sa, a, sb, b, a, sa, sb);
  }
  return {
    origin,
    positionHigh,
    positionLow,
    chunkPosition,
    indices: Uint32Array.from(indices),
  };
}
