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
import { geodeticToEcef } from "#src/geo/globe.js";
import type { GlobeTileLevel } from "#src/geo/globe_tiles.js";
import { computeGlobeTileMesh } from "#src/sliceview/globe.js";

/**
 * Level of an equirectangular source with 1-degree voxels covering the Earth, whose voxels with
 * `x >= invalidX` cannot be mapped to geodetic coordinates.
 */
function makeLevel(invalidX = Infinity): GlobeTileLevel {
  return {
    tileSize: [90, 90],
    lowerTile: [0, 0],
    upperTile: [4, 2],
    lowerVoxel: [0, 0],
    upperVoxel: [360, 180],
    toLevel0: [1, 0, 0, 1, 0, 0],
    fromLevel0: [1, 0, 0, 1, 0, 0],
    toLonLat(x, y, out) {
      if (x >= invalidX) return false;
      out[0] = x - 180;
      out[1] = 90 - y;
      return true;
    },
  };
}

describe("computeGlobeTileMesh", () => {
  it("maps tiles onto the ellipsoid with outward-facing triangles", () => {
    const full = computeGlobeTileMesh(makeLevel(), 2, 0, Math.PI / 2);
    const n = Math.round(Math.sqrt(full.chunkPosition.length / 2)) - 1;
    expect(full.indices.length).toBeGreaterThan(0);
    // Vertices are relative to the origin, and lie on the ellipsoid.
    const expected = geodeticToEcef(45, 45, 0, new Float64Array(3));
    const v = (n / 2) * (n + 1) + n / 2;
    for (let k = 0; k < 3; ++k) {
      const p =
        full.origin[k] +
        full.positionHigh[3 * v + k] +
        full.positionLow[3 * v + k];
      expect(p).toBeCloseTo(expected[k], 0);
    }
    expect(full.chunkPosition[2 * v]).toBeCloseTo(45, 5);
    expect(full.chunkPosition[2 * v + 1]).toBeCloseTo(45, 5);
    // Triangles are wound counter-clockwise as seen from outside.
    const position = (i: number) =>
      [0, 1, 2].map(
        (k) =>
          full.origin[k] +
          full.positionHigh[3 * i + k] +
          full.positionLow[3 * i + k],
      );
    for (let t = 0; t < full.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((i) => position(full.indices[t + i]));
      const u = [0, 1, 2].map((k) => b[k] - a[k]);
      const w = [0, 1, 2].map((k) => c[k] - a[k]);
      const normal = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      ];
      expect(
        normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2],
      ).toBeGreaterThan(0);
    }
    // Cells with vertices that cannot be mapped are omitted.
    const partial = computeGlobeTileMesh(makeLevel(225), 2, 0, Math.PI / 2);
    expect(partial.indices.length).toBeGreaterThan(0);
    expect(partial.indices.length).toBeLessThan(full.indices.length);
    for (const i of partial.indices) {
      expect(partial.chunkPosition[2 * i]).toBeLessThan(45);
    }
  });
});
