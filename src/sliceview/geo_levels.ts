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
 * @file Per-region selection of the resolution levels of warped (reprojected) multiscale sources.
 *
 * For an unwarped source, a single resolution level is appropriate for the entire view.  For a
 * reprojected source, the resolution of the source relative to the display can vary greatly
 * across the view: e.g. near the pole of a polar display CRS, a small region of the view covers
 * all longitudes of a source in geographic coordinates, such that a single resolution level chosen
 * for the center of the view would require an enormous number of tiles.
 *
 * Following the approach of GDAL (`gdalwarp -ovr AUTO`, which compares source and destination
 * resolution over a sample grid) and Cesium/OpenLayers (which choose the source level per target
 * tile), the view is divided into cells, the source footprint of each cell is determined by
 * sampling, and a level is chosen for each cell based on the local ratio of source to display
 * resolution.  The number of tiles is bounded per cell and per view by choosing coarser levels.
 * Each level is drawn in the cells for which it, or a finer level, was chosen, such that coarser
 * levels fill in while finer levels load.
 */

import type { Affine2d } from "#src/geo/source_warp.js";

/**
 * Spacing, in pixels, of the lattice of sample points.
 */
export const GEO_LEVEL_SAMPLE_SPACING = 32;

/**
 * Number of lattice steps per cell along each axis.
 */
export const GEO_LEVEL_CELL_STEPS = 4;

/**
 * Maximum number of tiles of the chosen level per cell (excluding coarser levels drawn as
 * fallback).
 */
export const GEO_LEVEL_MAX_TILES_PER_CELL = 24;

/**
 * Maximum number of distinct tiles of the chosen levels in the view.
 */
export const GEO_LEVEL_MAX_TILES_PER_VIEW = 768;

export interface GeoLevelInput {
  /**
   * Transform from true voxel coordinates of the finest level (index 0) to true voxel coordinates
   * of this level, for the two warped dimensions.
   */
  fromLevel0: Affine2d;
  chunkSizeX: number;
  chunkSizeY: number;
  /**
   * Chunk grid bounds `[lower, upper)` along the two warped dimensions.
   */
  lowerChunkX: number;
  lowerChunkY: number;
  upperChunkX: number;
  upperChunkY: number;
}

export interface GeoLevelPlanInput {
  /**
   * Levels, from finest to coarsest.
   */
  levels: GeoLevelInput[];
  /**
   * Size of the view in pixels.
   */
  width: number;
  height: number;
  /**
   * Maps the pixel position `(px, py)` to true voxel coordinates of the finest level, stored in
   * `out`.  Returns the index of the world copy containing the position, or `undefined` if the
   * position is not within the source.
   */
  screenToSource: (
    px: number,
    py: number,
    out: Float64Array,
  ) => number | undefined;
  /**
   * Target ratio of the voxel size of the chosen level to the pixel size.
   */
  renderScaleTarget: number;
  maxTilesPerCell?: number;
  maxTilesPerView?: number;
}

export interface GeoLevelPlan {
  /**
   * For each level, the visible chunks, as a map from `chunkKey(level, x, y)` to the distance in
   * pixels between the center of the view and the nearest cell in which the chunk is needed.
   */
  chunks: Map<number, number>[];
  /**
   * Chosen level of each cell (for testing and debugging).
   */
  cellLevels: number[];
}

/**
 * Returns the key of the chunk `(x, y)` of a level in `GeoLevelPlan.chunks`.
 */
export function geoLevelChunkKey(level: GeoLevelInput, x: number, y: number) {
  return (
    (x - level.lowerChunkX) * (level.upperChunkY - level.lowerChunkY) +
    (y - level.lowerChunkY)
  );
}

/**
 * Inverse of `geoLevelChunkKey`.
 */
export function geoLevelChunkFromKey(
  level: GeoLevelInput,
  key: number,
): [number, number] {
  const numY = level.upperChunkY - level.lowerChunkY;
  const y = key % numY;
  return [level.lowerChunkX + (key - y) / numY, level.lowerChunkY + y];
}

/**
 * Bounding box of the source footprint (true voxel coordinates of the finest level) of a cell
 * within a single world copy.
 */
interface FootprintBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface Cell {
  boxes: FootprintBox[];
  /**
   * Finest-level voxels per pixel.
   */
  sourcePerPixel: number;
  /**
   * Distance in pixels from the center of the view.
   */
  distance: number;
  level: number;
}

function getLevelScale(level: GeoLevelInput) {
  const [a00, a10, a01, a11] = level.fromLevel0;
  // Finest-level voxels per voxel of this level.
  return 1 / Math.sqrt(Math.abs(a00 * a11 - a01 * a10));
}

const tempPoint = new Float64Array(2);

/**
 * Computes the inclusive range `[x0, x1, y0, y1]` of chunks of `level` intersecting `box`, stored
 * in `out`.  The range is empty if `x0 > x1` or `y0 > y1`.
 */
function getChunkRange(level: GeoLevelInput, box: FootprintBox, out: number[]) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const t = level.fromLevel0;
  for (const x of [box.xMin, box.xMax]) {
    for (const y of [box.yMin, box.yMax]) {
      const lx = t[0] * x + t[2] * y + t[4];
      const ly = t[1] * x + t[3] * y + t[5];
      xMin = Math.min(xMin, lx);
      xMax = Math.max(xMax, lx);
      yMin = Math.min(yMin, ly);
      yMax = Math.max(yMax, ly);
    }
  }
  out[0] = Math.max(level.lowerChunkX, Math.floor(xMin / level.chunkSizeX));
  out[1] = Math.min(level.upperChunkX - 1, Math.floor(xMax / level.chunkSizeX));
  out[2] = Math.max(level.lowerChunkY, Math.floor(yMin / level.chunkSizeY));
  out[3] = Math.min(level.upperChunkY - 1, Math.floor(yMax / level.chunkSizeY));
}

const tempRange = [0, 0, 0, 0];

/**
 * Invokes `callback` for each chunk of `level` intersecting `box`.
 */
function forEachChunkInBox(
  level: GeoLevelInput,
  box: FootprintBox,
  callback: (x: number, y: number) => void,
) {
  getChunkRange(level, box, tempRange);
  const [x0, x1, y0, y1] = tempRange;
  for (let x = x0; x <= x1; ++x) {
    for (let y = y0; y <= y1; ++y) {
      callback(x, y);
    }
  }
}

/**
 * Returns the number of chunks of `level` intersecting `boxes` (counting chunks intersecting
 * multiple boxes multiple times), without enumerating them.
 */
function countChunks(level: GeoLevelInput, boxes: FootprintBox[]) {
  let count = 0;
  for (const box of boxes) {
    getChunkRange(level, box, tempRange);
    const [x0, x1, y0, y1] = tempRange;
    if (x1 >= x0 && y1 >= y0) count += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return count;
}

/**
 * Determines the visible chunks of each level of a warped multiscale source.
 */
export function computeGeoLevelPlan(input: GeoLevelPlanInput): GeoLevelPlan {
  const {
    levels,
    width,
    height,
    screenToSource,
    renderScaleTarget,
    maxTilesPerCell = GEO_LEVEL_MAX_TILES_PER_CELL,
    maxTilesPerView = GEO_LEVEL_MAX_TILES_PER_VIEW,
  } = input;
  const numLevels = levels.length;
  const chunks = levels.map(() => new Map<number, number>());
  if (numLevels === 0 || !(width > 0) || !(height > 0)) {
    return { chunks, cellLevels: [] };
  }
  const levelScales = levels.map(getLevelScale);

  // Sample the source position of each lattice point.
  const spacing = GEO_LEVEL_SAMPLE_SPACING;
  const nx = Math.ceil(width / spacing);
  const ny = Math.ceil(height / spacing);
  const stride = nx + 1;
  const numPoints = stride * (ny + 1);
  const pointX = new Float64Array(numPoints);
  const pointY = new Float64Array(numPoints);
  const pointCopy = new Float64Array(numPoints);
  const getPixelX = (i: number) => Math.min(width, i * spacing);
  const getPixelY = (j: number) => Math.min(height, j * spacing);
  for (let j = 0; j <= ny; ++j) {
    for (let i = 0; i <= nx; ++i) {
      const index = j * stride + i;
      const copy = screenToSource(getPixelX(i), getPixelY(j), tempPoint);
      if (copy === undefined) {
        pointCopy[index] = Number.NaN;
        continue;
      }
      pointCopy[index] = copy;
      pointX[index] = tempPoint[0];
      pointY[index] = tempPoint[1];
    }
  }

  // Determine the footprint and resolution of each cell.
  const cellSteps = GEO_LEVEL_CELL_STEPS;
  const cells: Cell[] = [];
  const centerX = width / 2;
  const centerY = height / 2;
  for (let cj = 0; cj * cellSteps < ny; ++cj) {
    for (let ci = 0; ci * cellSteps < nx; ++ci) {
      const i0 = ci * cellSteps;
      const j0 = cj * cellSteps;
      const i1 = Math.min(nx, i0 + cellSteps);
      const j1 = Math.min(ny, j0 + cellSteps);
      // Footprint boxes and padding (maximum displacement between adjacent samples, which
      // accounts for parts of the footprint between samples) per world copy.
      const boxes = new Map<
        number,
        FootprintBox & { padX: number; padY: number }
      >();
      for (let j = j0; j <= j1; ++j) {
        for (let i = i0; i <= i1; ++i) {
          const index = j * stride + i;
          const copy = pointCopy[index];
          if (Number.isNaN(copy)) continue;
          const x = pointX[index];
          const y = pointY[index];
          let box = boxes.get(copy);
          if (box === undefined) {
            box = { xMin: x, yMin: y, xMax: x, yMax: y, padX: 0, padY: 0 };
            boxes.set(copy, box);
          } else {
            box.xMin = Math.min(box.xMin, x);
            box.yMin = Math.min(box.yMin, y);
            box.xMax = Math.max(box.xMax, x);
            box.yMax = Math.max(box.yMax, y);
          }
          for (const neighbor of [
            i < i1 ? index + 1 : -1,
            j < j1 ? index + stride : -1,
          ]) {
            if (neighbor === -1 || pointCopy[neighbor] !== copy) continue;
            box.padX = Math.max(box.padX, Math.abs(pointX[neighbor] - x));
            box.padY = Math.max(box.padY, Math.abs(pointY[neighbor] - y));
          }
        }
      }
      if (boxes.size === 0) continue;
      // Resolution: finest-level voxels per pixel, from the source area of each sub-square of the
      // lattice.  The minimum is used, such that the finest resolution needed within the cell is
      // chosen (subject to the tile limits).
      let sourcePerPixel = Infinity;
      for (let j = j0; j < j1; ++j) {
        for (let i = i0; i < i1; ++i) {
          const a = j * stride + i;
          const b = a + 1;
          const c = a + stride + 1;
          const d = a + stride;
          const copy = pointCopy[a];
          if (
            Number.isNaN(copy) ||
            pointCopy[b] !== copy ||
            pointCopy[c] !== copy ||
            pointCopy[d] !== copy
          ) {
            continue;
          }
          const area =
            0.5 *
            Math.abs(
              (pointX[a] - pointX[c]) * (pointY[b] - pointY[d]) -
                (pointX[b] - pointX[d]) * (pointY[a] - pointY[c]),
            );
          const pixelArea =
            (getPixelX(i + 1) - getPixelX(i)) *
            (getPixelY(j + 1) - getPixelY(j));
          if (!(area > 0) || !(pixelArea > 0)) continue;
          sourcePerPixel = Math.min(
            sourcePerPixel,
            Math.sqrt(area / pixelArea),
          );
        }
      }
      const cellBoxes: FootprintBox[] = [];
      for (const box of boxes.values()) {
        if (sourcePerPixel === Infinity) {
          // No complete sub-square (e.g. at the edge of the source): estimate from the box.
          const cellArea =
            (getPixelX(i1) - getPixelX(i0)) * (getPixelY(j1) - getPixelY(j0));
          const area = (box.xMax - box.xMin) * (box.yMax - box.yMin);
          if (area > 0 && cellArea > 0) {
            sourcePerPixel = Math.min(
              sourcePerPixel,
              Math.sqrt(area / cellArea),
            );
          }
        }
        cellBoxes.push(box);
      }
      if (sourcePerPixel === Infinity) {
        // Degenerate footprint (single sample): assume the finest level.
        sourcePerPixel = 0;
      }
      for (const box of boxes.values()) {
        const padX = box.padX || sourcePerPixel * spacing;
        const padY = box.padY || sourcePerPixel * spacing;
        box.xMin -= padX;
        box.xMax += padX;
        box.yMin -= padY;
        box.yMax += padY;
      }
      const cx = 0.5 * (getPixelX(i0) + getPixelX(i1));
      const cy = 0.5 * (getPixelY(j0) + getPixelY(j1));
      cells.push({
        boxes: cellBoxes,
        sourcePerPixel,
        distance: Math.hypot(cx - centerX, cy - centerY),
        level: 0,
      });
    }
  }

  // Choose the level of each cell: the level whose voxel size is closest to the target, coarsened
  // until the number of tiles is within the per-cell limit.
  for (const cell of cells) {
    const target = cell.sourcePerPixel * renderScaleTarget;
    let best = 0;
    for (let level = 1; level < numLevels; ++level) {
      if (
        Math.abs(levelScales[level] - target) <
        Math.abs(levelScales[best] - target)
      ) {
        best = level;
      }
    }
    while (
      best + 1 < numLevels &&
      countChunks(levels[best], cell.boxes) > maxTilesPerCell
    ) {
      ++best;
    }
    cell.level = best;
  }

  // Enforce the per-view limit by coarsening the cells with the finest levels.  (After the per-cell
  // limit, each cell has a bounded number of tiles unless it is at the coarsest level, so
  // enumerating them is cheap.)
  while (true) {
    const unique = levels.map(() => new Set<number>());
    let total = 0;
    let finest = numLevels;
    for (const cell of cells) {
      const level = levels[cell.level];
      const set = unique[cell.level];
      for (const box of cell.boxes) {
        forEachChunkInBox(level, box, (x, y) => {
          const key = geoLevelChunkKey(level, x, y);
          if (!set.has(key)) {
            set.add(key);
            ++total;
          }
        });
      }
      finest = Math.min(finest, cell.level);
    }
    if (total <= maxTilesPerView || finest + 1 >= numLevels) break;
    for (const cell of cells) {
      if (cell.level === finest) ++cell.level;
    }
  }

  // Each level is drawn in the cells for which it or a finer level was chosen.
  for (const cell of cells) {
    for (let l = cell.level; l < numLevels; ++l) {
      const level = levels[l];
      const map = chunks[l];
      for (const box of cell.boxes) {
        forEachChunkInBox(level, box, (x, y) => {
          const key = geoLevelChunkKey(level, x, y);
          const prev = map.get(key);
          if (prev === undefined || cell.distance < prev) {
            map.set(key, cell.distance);
          }
        });
      }
    }
  }
  return { chunks, cellLevels: cells.map((cell) => cell.level) };
}
