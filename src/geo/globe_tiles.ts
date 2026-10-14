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
 * @file Selection of the tiles (chunks) of multiscale georeferenced image sources to show on the
 * 3-d globe (see `src/geo/globe.ts`).
 *
 * Starting from the coarsest resolution, tiles are refined into the overlapping tiles of the next
 * finer resolution while a texel of the tile, at the distance of the tile from the camera, covers
 * more than a target number of pixels (screen-space error, as in Cesium and the multiscale meshes
 * of Neuroglancer).  Tiles beyond the horizon or outside the view frustum are culled.
 */

import { geodeticToEcef, WGS84_SEMI_MINOR_AXIS } from "#src/geo/globe.js";
import type { Affine2d } from "#src/geo/source_warp.js";
import { applyAffine2d } from "#src/geo/source_warp.js";

/**
 * A resolution level of a georeferenced image source.
 */
export interface GlobeTileLevel {
  /**
   * Size of a tile in voxels along the two georeferenced dimensions.
   */
  tileSize: [number, number];
  /**
   * Tile grid bounds `[lower, upper)`.
   */
  lowerTile: [number, number];
  upperTile: [number, number];
  /**
   * Voxel bounds of the source data, `[lower, upper)`.
   */
  lowerVoxel: [number, number];
  upperVoxel: [number, number];
  /**
   * Transform from voxel coordinates of this level to voxel coordinates of the finest level.
   */
  toLevel0: Affine2d;
  /**
   * Inverse of `toLevel0`.
   */
  fromLevel0: Affine2d;
  /**
   * Converts voxel coordinates of this level to geodetic coordinates `[lon, lat]` (degrees).
   * Returns `false` if the position cannot be converted.
   */
  toLonLat(x: number, y: number, out: Float64Array): boolean;
}

export interface GlobeTileView {
  /**
   * ECEF coordinates of the camera.
   */
  eye: Float64Array;
  /**
   * ECEF coordinates of the origin of render coordinates (the camera target).
   */
  target: Float64Array;
  /**
   * Transform from render coordinates to clip coordinates.
   */
  viewProjectionMat: ArrayLike<number>;
  /**
   * Angle subtended by a pixel.
   */
  pixelAngle: number;
}

export interface GlobeTile {
  level: number;
  x: number;
  y: number;
  /**
   * Distance in meters between the camera and the nearest sample of the tile.
   */
  distance: number;
}

/**
 * Number of samples per edge of a tile used to estimate its footprint.
 */
const TILE_SAMPLES = 5;

/**
 * Footprint of a tile: ECEF coordinates of a grid of samples (`NaN` for invalid samples), the
 * maximum ground distance per voxel, and a cone (from the center of the Earth) bounding the tile.
 */
export interface GlobeTileFootprint {
  ecef: Float64Array;
  metersPerVoxel: number;
  numValid: number;
  /**
   * Unit vector of the axis of the bounding cone.
   */
  axis: Float64Array;
  /**
   * Half-angle (radians) of the bounding cone.
   */
  coneAngle: number;
  /**
   * Maximum distance in meters between adjacent samples.
   */
  sampleSpacing: number;
}

const tempLonLat = new Float64Array(2);

/**
 * Computes the footprint of a tile.
 */
export function computeGlobeTileFootprint(
  level: GlobeTileLevel,
  x: number,
  y: number,
): GlobeTileFootprint {
  const n = TILE_SAMPLES;
  const ecef = new Float64Array(n * n * 3).fill(Number.NaN);
  const [sx, sy] = level.tileSize;
  const x0 = Math.max(level.lowerVoxel[0], x * sx);
  const y0 = Math.max(level.lowerVoxel[1], y * sy);
  const x1 = Math.min(level.upperVoxel[0], (x + 1) * sx);
  const y1 = Math.min(level.upperVoxel[1], (y + 1) * sy);
  let numValid = 0;
  for (let j = 0; j < n; ++j) {
    for (let i = 0; i < n; ++i) {
      const vx = x0 + ((x1 - x0) * i) / (n - 1);
      const vy = y0 + ((y1 - y0) * j) / (n - 1);
      if (!level.toLonLat(vx, vy, tempLonLat)) continue;
      geodeticToEcef(tempLonLat[0], tempLonLat[1], 0, ecef, 3 * (j * n + i));
      ++numValid;
    }
  }
  // Ground distance per voxel, from the distances between adjacent samples.
  let metersPerVoxel = 0;
  const stepX = (x1 - x0) / (n - 1);
  const stepY = (y1 - y0) / (n - 1);
  const distance = (a: number, b: number) =>
    Math.hypot(
      ecef[3 * a] - ecef[3 * b],
      ecef[3 * a + 1] - ecef[3 * b + 1],
      ecef[3 * a + 2] - ecef[3 * b + 2],
    );
  for (let j = 0; j < n; ++j) {
    for (let i = 0; i < n; ++i) {
      const a = j * n + i;
      if (i + 1 < n) {
        const d = distance(a, a + 1) / stepX;
        if (d > metersPerVoxel) metersPerVoxel = d;
      }
      if (j + 1 < n) {
        const d = distance(a, a + n) / stepY;
        if (d > metersPerVoxel) metersPerVoxel = d;
      }
    }
  }
  // Bounding cone: the mean direction of the samples, with a margin of the angle between adjacent
  // samples to account for the parts of the tile between samples.
  const axis = new Float64Array(3);
  for (let i = 0; i < n * n; ++i) {
    const px = ecef[3 * i];
    if (Number.isNaN(px)) continue;
    const r = Math.hypot(px, ecef[3 * i + 1], ecef[3 * i + 2]);
    for (let k = 0; k < 3; ++k) axis[k] += ecef[3 * i + k] / r;
  }
  const axisNorm = Math.hypot(axis[0], axis[1], axis[2]);
  let coneAngle = Math.PI;
  const sampleSpacing = metersPerVoxel * Math.max(stepX, stepY);
  if (axisNorm > 1e-6) {
    for (let k = 0; k < 3; ++k) axis[k] /= axisNorm;
    let maxAngle = 0;
    for (let i = 0; i < n * n; ++i) {
      const px = ecef[3 * i];
      if (Number.isNaN(px)) continue;
      const py = ecef[3 * i + 1];
      const pz = ecef[3 * i + 2];
      const r = Math.hypot(px, py, pz);
      const c = (axis[0] * px + axis[1] * py + axis[2] * pz) / r;
      maxAngle = Math.max(maxAngle, Math.acos(Math.min(1, Math.max(-1, c))));
    }
    coneAngle = Math.min(
      Math.PI,
      maxAngle + Math.min(Math.PI, sampleSpacing / WGS84_SEMI_MINOR_AXIS),
    );
  }
  return { ecef, metersPerVoxel, numValid, axis, coneAngle, sampleSpacing };
}

/**
 * Cache of tile footprints, which do not depend on the view.
 */
export class GlobeTileFootprintCache {
  private footprints = new Map<string, GlobeTileFootprint>();
  constructor(public maxSize = 1 << 16) {}

  get(levels: readonly GlobeTileLevel[], level: number, x: number, y: number) {
    const key = `${level},${x},${y}`;
    const { footprints } = this;
    let footprint = footprints.get(key);
    if (footprint === undefined) {
      footprint = computeGlobeTileFootprint(levels[level], x, y);
      footprints.set(key, footprint);
      if (footprints.size > this.maxSize) {
        footprints.delete(footprints.keys().next().value!);
      }
    }
    return footprint;
  }
}

/**
 * Margin, in normalized device coordinates, by which the projected bounds of the samples of a tile
 * are extended for frustum culling, to account for the curvature of the tile between samples.
 */
const FRUSTUM_MARGIN = 0.25;

/**
 * Tests whether a tile may be visible, and returns a lower bound on the distance from the camera to
 * the tile, or `undefined` if it is not visible.
 */
function getVisibleTileDistance(
  footprint: GlobeTileFootprint,
  view: GlobeTileView,
): number | undefined {
  const { ecef, axis, coneAngle, sampleSpacing } = footprint;
  const { eye, target, viewProjectionMat: m } = view;
  // Horizon test, approximating the Earth by a sphere of radius equal to the semi-minor axis: the
  // tile is hidden if its bounding cone lies entirely beyond the horizon circle.
  const eyeRadius = Math.hypot(eye[0], eye[1], eye[2]);
  const horizonAngle =
    eyeRadius > WGS84_SEMI_MINOR_AXIS
      ? Math.acos(WGS84_SEMI_MINOR_AXIS / eyeRadius)
      : 0;
  const eyeAxisAngle = Math.acos(
    Math.min(
      1,
      Math.max(
        -1,
        (axis[0] * eye[0] + axis[1] * eye[1] + axis[2] * eye[2]) / eyeRadius,
      ),
    ),
  );
  if (eyeAxisAngle > horizonAngle + coneAngle) return undefined;
  const numSamples = ecef.length / 3;
  let minDistance = Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let anyBehind = false;
  for (let i = 0; i < numSamples; ++i) {
    const px = ecef[3 * i];
    if (Number.isNaN(px)) continue;
    const py = ecef[3 * i + 1];
    const pz = ecef[3 * i + 2];
    const d = Math.hypot(eye[0] - px, eye[1] - py, eye[2] - pz);
    if (d < minDistance) minDistance = d;
    const rx = px - target[0];
    const ry = py - target[1];
    const rz = pz - target[2];
    const cw = m[3] * rx + m[7] * ry + m[11] * rz + m[15];
    if (cw <= 0) {
      anyBehind = true;
      continue;
    }
    const cx = (m[0] * rx + m[4] * ry + m[8] * rz + m[12]) / cw;
    const cy = (m[1] * rx + m[5] * ry + m[9] * rz + m[13]) / cw;
    xMin = Math.min(xMin, cx);
    xMax = Math.max(xMax, cx);
    yMin = Math.min(yMin, cy);
    yMax = Math.max(yMax, cy);
  }
  const limit = 1 + FRUSTUM_MARGIN;
  if (
    !anyBehind &&
    (xMin > limit || xMax < -limit || yMin > limit || yMax < -limit)
  ) {
    return undefined;
  }
  // The camera may be closer to parts of the tile between samples than to any sample.
  const altitude = Math.max(1, eyeRadius - WGS84_SEMI_MINOR_AXIS);
  return Math.max(altitude, minDistance - sampleSpacing);
}

export interface SelectGlobeTilesOptions {
  /**
   * Maximum number of pixels covered by a texel of a selected tile, unless no finer resolution is
   * available.
   */
  maxPixelsPerTexel?: number;
  /**
   * Maximum number of selected tiles.  Beyond this, refinement stops.
   */
  maxTiles?: number;
}

/**
 * Returns the tiles of the level `level - 1` overlapping the tile `(x, y)` of `level`.
 */
export function getGlobeTileChildren(
  levels: readonly GlobeTileLevel[],
  level: number,
  x: number,
  y: number,
): [number, number][] {
  const parent = levels[level];
  const child = levels[level - 1];
  const [sx, sy] = parent.tileSize;
  const corners = [
    [x * sx, y * sy],
    [(x + 1) * sx, y * sy],
    [x * sx, (y + 1) * sy],
    [(x + 1) * sx, (y + 1) * sy],
  ];
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  const p = new Float64Array(2);
  for (const [cx, cy] of corners) {
    applyAffine2d(parent.toLevel0, cx, cy, p);
    applyAffine2d(child.fromLevel0, p[0], p[1], p);
    xMin = Math.min(xMin, p[0]);
    xMax = Math.max(xMax, p[0]);
    yMin = Math.min(yMin, p[1]);
    yMax = Math.max(yMax, p[1]);
  }
  const [csx, csy] = child.tileSize;
  const eps = 1e-6;
  const tx0 = Math.max(child.lowerTile[0], Math.floor(xMin / csx + eps));
  const tx1 = Math.min(child.upperTile[0] - 1, Math.ceil(xMax / csx - eps) - 1);
  const ty0 = Math.max(child.lowerTile[1], Math.floor(yMin / csy + eps));
  const ty1 = Math.min(child.upperTile[1] - 1, Math.ceil(yMax / csy - eps) - 1);
  const result: [number, number][] = [];
  for (let ty = ty0; ty <= ty1; ++ty) {
    for (let tx = tx0; tx <= tx1; ++tx) {
      result.push([tx, ty]);
    }
  }
  return result;
}

/**
 * Returns the tile of `ancestorLevel` containing the center of the tile `(x, y)` of `level`.
 */
export function getGlobeTileAncestor(
  levels: readonly GlobeTileLevel[],
  level: number,
  x: number,
  y: number,
  ancestorLevel: number,
): [number, number] {
  const tile = levels[level];
  const ancestor = levels[ancestorLevel];
  const p = new Float64Array(2);
  applyAffine2d(
    tile.toLevel0,
    (x + 0.5) * tile.tileSize[0],
    (y + 0.5) * tile.tileSize[1],
    p,
  );
  applyAffine2d(ancestor.fromLevel0, p[0], p[1], p);
  return [
    Math.floor(p[0] / ancestor.tileSize[0]),
    Math.floor(p[1] / ancestor.tileSize[1]),
  ];
}

/**
 * Selects the tiles to show.  `levels` are ordered from finest to coarsest.
 */
export function selectGlobeTiles(
  levels: readonly GlobeTileLevel[],
  view: GlobeTileView,
  cache: GlobeTileFootprintCache,
  options: SelectGlobeTilesOptions = {},
): GlobeTile[] {
  const { maxPixelsPerTexel = 1.5, maxTiles = 1024 } = options;
  const numLevels = levels.length;
  const selected: GlobeTile[] = [];
  if (numLevels === 0) return selected;
  const visit = (level: number, x: number, y: number) => {
    const footprint = cache.get(levels, level, x, y);
    if (footprint.numValid === 0) return;
    const distance = getVisibleTileDistance(footprint, view);
    if (distance === undefined) return;
    const pixelsPerTexel =
      footprint.metersPerVoxel / (Math.max(distance, 1) * view.pixelAngle);
    if (
      level > 0 &&
      pixelsPerTexel > maxPixelsPerTexel &&
      selected.length < maxTiles
    ) {
      for (const [cx, cy] of getGlobeTileChildren(levels, level, x, y)) {
        visit(level - 1, cx, cy);
      }
      return;
    }
    selected.push({ level, x, y, distance });
  };
  const coarsest = numLevels - 1;
  const top = levels[coarsest];
  for (let y = top.lowerTile[1]; y < top.upperTile[1]; ++y) {
    for (let x = top.lowerTile[0]; x < top.upperTile[0]; ++x) {
      visit(coarsest, x, y);
    }
  }
  return selected;
}
