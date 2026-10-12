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

import { describe, expect, it } from "vitest";
import { computeGlobeCamera, getGlobePixelAngle } from "#src/geo/globe.js";
import type { GlobeTileLevel, GlobeTileView } from "#src/geo/globe_tiles.js";
import {
  getGlobeTileAncestor,
  getGlobeTileChildren,
  GlobeTileFootprintCache,
  selectGlobeTiles,
} from "#src/geo/globe_tiles.js";
import { mat4, quat } from "#src/util/geom.js";

const MAX_ZOOM = 8;
const TILE_SIZE = 256;

/**
 * Levels of a Web Mercator tile pyramid (zoom levels `MAX_ZOOM` down to 0), ordered from finest to
 * coarsest, with voxel coordinates in pixels of the zoom level.
 */
function makeWebMercatorLevels(): GlobeTileLevel[] {
  const levels: GlobeTileLevel[] = [];
  for (let z = MAX_ZOOM; z >= 0; --z) {
    const n = 1 << z;
    const scale = 1 << (MAX_ZOOM - z);
    const size = n * TILE_SIZE;
    levels.push({
      tileSize: [TILE_SIZE, TILE_SIZE],
      lowerTile: [0, 0],
      upperTile: [n, n],
      lowerVoxel: [0, 0],
      upperVoxel: [size, size],
      toLevel0: [scale, 0, 0, scale, 0, 0],
      fromLevel0: [1 / scale, 0, 0, 1 / scale, 0, 0],
      toLonLat(x, y, out) {
        out[0] = (x / size) * 360 - 180;
        out[1] =
          (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) /
          Math.PI;
        return true;
      },
    });
  }
  return levels;
}

function makeView(lon: number, lat: number, distance: number): GlobeTileView {
  const width = 800;
  const height = 600;
  const camera = computeGlobeCamera({
    lon,
    lat,
    distance,
    orientation: quat.create(),
    width,
    height,
  });
  const viewMatrix = mat4.invert(mat4.create(), camera.invViewMatrix)!;
  return {
    eye: camera.eye,
    target: camera.target,
    viewProjectionMat: mat4.multiply(
      mat4.create(),
      camera.projectionMat,
      viewMatrix,
    ),
    pixelAngle: getGlobePixelAngle(height),
  };
}

/**
 * Returns the Web Mercator tile coordinates at zoom `z` containing `[lon, lat]`.
 */
function getTile(lon: number, lat: number, z: number): [number, number] {
  const n = 1 << z;
  const phi = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n),
  ];
}

describe("globe tile selection", () => {
  it("selects visible tiles with a resolution matching the distance", () => {
    const levels = makeWebMercatorLevels();
    const cache = new GlobeTileFootprintCache();
    expect(selectGlobeTiles([], makeView(0, 0, 1e7), cache)).toEqual([]);

    // Children and ancestors are consistent.
    expect(getGlobeTileChildren(levels, 3, 5, 6)).toEqual([
      [10, 12],
      [11, 12],
      [10, 13],
      [11, 13],
    ]);
    expect(getGlobeTileAncestor(levels, 0, 200, 100, 3)).toEqual([25, 12]);

    let previousLevel = -1;
    for (const [lon, lat, distance] of [
      [140, 36, 4e7],
      [140, 36, 4e6],
      [140, 36, 4e5],
      [-120, -40, 4e5],
    ]) {
      const view = makeView(lon, lat, distance);
      const tiles = selectGlobeTiles(levels, view, cache);
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles.length).toBeLessThan(400);
      // Selected tiles do not overlap: no selected tile is the ancestor of another.
      const keys = new Set(tiles.map((t) => `${t.level},${t.x},${t.y}`));
      for (const t of tiles) {
        for (let a = t.level + 1; a < levels.length; ++a) {
          const [ax, ay] = getGlobeTileAncestor(levels, t.level, t.x, t.y, a);
          expect(keys.has(`${a},${ax},${ay}`)).toBe(false);
        }
      }
      // The tile below the camera is selected, with a level that becomes finer as the camera
      // approaches.
      const below = tiles.find((t) => {
        const [x, y] = getTile(lon, lat, MAX_ZOOM - t.level);
        return t.x === x && t.y === y;
      });
      expect(below).toBeDefined();
      if (lon === 140) {
        expect(below!.level).toBeLessThan(
          previousLevel === -1 ? levels.length : previousLevel,
        );
        previousLevel = below!.level;
      }
      // Tiles on the opposite side of the Earth are culled.
      const [px, py] = getTile(lon > 0 ? lon - 180 : lon + 180, -lat, 2);
      const antipodalLevel = MAX_ZOOM - 2;
      for (const t of tiles) {
        if (t.level > antipodalLevel) continue;
        expect(
          getGlobeTileAncestor(levels, t.level, t.x, t.y, antipodalLevel),
        ).not.toEqual([px, py]);
      }
    }

    // The number of tiles is limited.
    const limited = selectGlobeTiles(levels, makeView(140, 36, 4e5), cache, {
      maxTiles: 10,
    });
    expect(limited.length).toBeLessThan(60);
  });
});
