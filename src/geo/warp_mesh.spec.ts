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
import { getCrs } from "#src/geo/crs.js";
import type { Affine2d } from "#src/geo/source_warp.js";
import {
  computeGeoWarpSpec,
  computeWarpedBounds,
  getMultiscaleGeoWarp,
} from "#src/geo/source_warp.js";
import { TransformStatus } from "#src/geo/transform.js";
import type { Warp2d, WarpMesh } from "#src/geo/warp_mesh.js";
import { computeWarpMesh } from "#src/geo/warp_mesh.js";

// Sentinel-2 tile 33UUU: 10980 x 10980 pixels of 10 m, origin (300000, 5900040) in UTM zone 33N.
const SENTINEL_TILE: Affine2d = [10, 0, 0, -10, 300000, 5900040];
const SENTINEL_SIZE = 10980;

function makeWarp(
  sourceCrs: string,
  displayCrs: string,
  multiscaleToSource: Affine2d,
  lower: number[],
  upper: number[],
) {
  return getMultiscaleGeoWarp(
    computeGeoWarpSpec(
      getCrs(sourceCrs),
      getCrs(displayCrs),
      [0, 1],
      multiscaleToSource,
      lower,
      upper,
    ),
  );
}

/**
 * Returns the maximum error, in output coordinates, of barycentric interpolation within the
 * triangles of `mesh`, evaluated at random points.
 */
function measureMeshError(
  warp: Warp2d,
  mesh: WarpMesh,
  samplesPerTriangle = 8,
) {
  const { indices, sourcePositions: s, outputPositions: o } = mesh;
  const exact = new Float64Array(2);
  let maxError = 0;
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    for (let j = 0; j < samplesPerTriangle; ++j) {
      let u = random();
      let v = random();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;
      const sx = w * s[2 * a] + u * s[2 * b] + v * s[2 * c];
      const sy = w * s[2 * a + 1] + u * s[2 * b + 1] + v * s[2 * c + 1];
      const ox = w * o[2 * a] + u * o[2 * b] + v * o[2 * c];
      const oy = w * o[2 * a + 1] + u * o[2 * b + 1] + v * o[2 * c + 1];
      if (warp.forward(sx, sy, exact) !== TransformStatus.VALID) continue;
      maxError = Math.max(maxError, Math.hypot(exact[0] - ox, exact[1] - oy));
    }
  }
  return maxError;
}

function getBoundaryVertices(
  mesh: WarpMesh,
  predicate: (x: number, y: number) => boolean,
) {
  const result: string[] = [];
  const { sourcePositions: s, outputPositions: o } = mesh;
  for (let i = 0; i < mesh.numVertices; ++i) {
    if (predicate(s[2 * i], s[2 * i + 1])) {
      result.push(`${s[2 * i]},${s[2 * i + 1]}->${o[2 * i]},${o[2 * i + 1]}`);
    }
  }
  return result.sort();
}

describe("computeWarpMesh", () => {
  it("produces meshes with bounded error", () => {
    const cases: {
      description: string;
      warp: Warp2d;
      rect: [number, number, number, number];
      maxError: number;
      maxTriangles?: number;
    }[] = [
      {
        description: "identity warp",
        warp: makeWarp(
          "EPSG:4326",
          "EPSG:4326",
          [0.1, 0, 0, -0.1, -180, 90],
          [0, 0],
          [3600, 1800],
        ),
        rect: [0, 0, 256, 256],
        maxError: 0.125,
        maxTriangles: 2,
      },
      {
        description: "UTM to geographic",
        warp: makeWarp(
          "EPSG:32633",
          "EPSG:4326",
          SENTINEL_TILE,
          [0, 0],
          [SENTINEL_SIZE, SENTINEL_SIZE],
        ),
        rect: [0, 0, SENTINEL_SIZE, SENTINEL_SIZE],
        maxError: 0.125,
      },
      {
        description: "UTM to Web Mercator",
        warp: makeWarp(
          "EPSG:32633",
          "EPSG:3857",
          SENTINEL_TILE,
          [0, 0],
          [SENTINEL_SIZE, SENTINEL_SIZE],
        ),
        rect: [1024, 2048, 2048, 3072],
        maxError: 0.25,
      },
      {
        description:
          "global geographic to polar stereographic, including the pole",
        warp: makeWarp(
          "EPSG:4326",
          "EPSG:3413",
          [1, 0, 0, -1, -180, 90],
          [0, 0],
          [360, 30],
        ),
        rect: [0, 0, 360, 30],
        maxError: 0.125,
      },
    ];
    for (const { description, warp, rect, maxError, maxTriangles } of cases) {
      const mesh = computeWarpMesh(warp, ...rect, { maxError });
      const numTriangles = mesh.indices.length / 3;
      expect(numTriangles, description).toBeGreaterThan(0);
      if (maxTriangles !== undefined) {
        expect(numTriangles, description).toBeLessThanOrEqual(maxTriangles);
      }
      // Sampled error may slightly exceed the target, since refinement only estimates the error.
      expect(measureMeshError(warp, mesh), description).toBeLessThan(
        maxError * 4,
      );
    }
  });

  it("produces identical vertices on the shared edge of adjacent rectangles", () => {
    const warp = makeWarp(
      "EPSG:32633",
      "EPSG:3413",
      SENTINEL_TILE,
      [0, 0],
      [SENTINEL_SIZE, SENTINEL_SIZE],
    );
    const left = computeWarpMesh(warp, 0, 0, 4096, 4096);
    const right = computeWarpMesh(warp, 4096, 0, 8192, 4096);
    const leftEdge = getBoundaryVertices(left, (x) => x === 4096);
    const rightEdge = getBoundaryVertices(right, (x) => x === 4096);
    expect(leftEdge.length).toBeGreaterThan(2);
    expect(leftEdge).toEqual(rightEdge);
  });

  it("omits triangles whose vertices cannot be transformed", () => {
    // The southern hemisphere cannot be shown in north polar stereographic near the south pole.
    const warp = makeWarp(
      "EPSG:4326",
      "EPSG:3413",
      [1, 0, 0, -1, -180, 90],
      [0, 0],
      [360, 180],
    );
    const mesh = computeWarpMesh(warp, 0, 0, 360, 180);
    const { indices, outputPositions } = mesh;
    for (const i of indices) {
      expect(Number.isFinite(outputPositions[2 * i])).toBe(true);
    }
  });
});

describe("MultiscaleGeoWarp", () => {
  it("maps through the affine approximation to exact display coordinates", () => {
    const spec = computeGeoWarpSpec(
      getCrs("EPSG:32633"),
      getCrs("EPSG:4326"),
      [0, 1],
      SENTINEL_TILE,
      [0, 0],
      [SENTINEL_SIZE, SENTINEL_SIZE],
    );
    const warp = getMultiscaleGeoWarp(spec);
    const warped = new Float64Array(2);
    const exact = new Float64Array(2);
    const back = new Float64Array(2);
    const [a00, a10, a01, a11, t0, t1] = spec.multiscaleToDisplay;
    for (const [x, y] of [
      [0, 0],
      [SENTINEL_SIZE, 0],
      [5490, 5490],
      [SENTINEL_SIZE, SENTINEL_SIZE],
    ]) {
      expect(warp.forward(x, y, warped)).toBe(TransformStatus.VALID);
      warp.toDisplay(x, y, exact);
      expect(a00 * warped[0] + a01 * warped[1] + t0).toBeCloseTo(exact[0], 9);
      expect(a10 * warped[0] + a11 * warped[1] + t1).toBeCloseTo(exact[1], 9);
      expect(warp.inverse(warped[0], warped[1], back)).toBe(
        TransformStatus.VALID,
      );
      expect(back[0]).toBeCloseTo(x, 5);
      expect(back[1]).toBeCloseTo(y, 5);
    }
    // The warp is close to the identity at the center of the source.
    warp.forward(5490, 5490, warped);
    expect(warped[0]).toBeCloseTo(5490, 3);
    expect(warped[1]).toBeCloseTo(5490, 3);
    const bounds = computeWarpedBounds(
      warp,
      [0, 0],
      [SENTINEL_SIZE, SENTINEL_SIZE],
    )!;
    expect(bounds.lower[0]).toBeLessThan(0);
    expect(bounds.upper[0]).toBeGreaterThan(SENTINEL_SIZE);
  });

  it("rejects sources entirely outside the display domain", () => {
    // Entirely north of the latitude limit of Web Mercator.
    expect(() =>
      computeGeoWarpSpec(
        getCrs("EPSG:4326"),
        getCrs("EPSG:3857"),
        [0, 1],
        [0.01, 0, 0, -0.01, 0, 89],
        [0, 0],
        [100, 100],
      ),
    ).toThrow(/cannot be displayed/);
  });
});
