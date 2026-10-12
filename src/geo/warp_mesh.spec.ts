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

// 13332 x 13332 pixels of 500 m, centered on the pole of a polar stereographic CRS.
const POLAR_GRID: Affine2d = [500, 0, 0, -500, -3333000, 3333000];
const POLAR_SIZE = 13332;

// Web Mercator grid of 1024 x 1024 pixels whose cell centers on the edges lie on +/-180 degrees.
const MERCATOR_PIXEL = 40075016.6856 / 1023;
const MERCATOR_OVERHANG_GRID: Affine2d = [
  MERCATOR_PIXEL,
  0,
  0,
  -MERCATOR_PIXEL,
  -20037508.3428 - MERCATOR_PIXEL / 2,
  20037508.3428 + MERCATOR_PIXEL / 2,
];

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

/**
 * Returns the maximum extent, in output coordinates, of the triangles of `mesh`.
 */
function getMaxTriangleExtent(mesh: WarpMesh) {
  const { indices, outputPositions: o } = mesh;
  let maxExtent = 0;
  for (let i = 0; i < indices.length; i += 3) {
    for (let k = 0; k < 2; ++k) {
      const v = [0, 1, 2].map((j) => o[2 * indices[i + j] + k]);
      maxExtent = Math.max(maxExtent, Math.max(...v) - Math.min(...v));
    }
  }
  return maxExtent;
}

/**
 * Returns the fraction of the area of the rectangle `[x0, x1] x [y0, y1]` covered by the triangles
 * of `mesh`.
 */
function getCoveredFraction(
  mesh: WarpMesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  const { indices, sourcePositions: s } = mesh;
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    area +=
      0.5 *
      Math.abs(
        (s[2 * b] - s[2 * a]) * (s[2 * c + 1] - s[2 * a + 1]) -
          (s[2 * c] - s[2 * a]) * (s[2 * b + 1] - s[2 * a + 1]),
      );
  }
  return area / ((x1 - x0) * (y1 - y0));
}

describe("computeWarpMesh across discontinuities", () => {
  // Computationally expensive.
  it(
    "omits triangles straddling discontinuities of the warp",
    { timeout: 60_000 },
    () => {
      const chunkSize = 256;
      const cases: {
        description: string;
        source: string;
        display: string;
        grid: Affine2d;
        size: [number, number];
        // Chunk origins (multiples of `chunkSize`) crossed by the discontinuity.
        chunks: [number, number][];
      }[] = [
        {
          // The antimeridian runs from the pole (at pixel 6666, 6666) towards +y.
          description: "south polar stereographic to geographic",
          source: "EPSG:3031",
          display: "EPSG:4326",
          grid: POLAR_GRID,
          size: [POLAR_SIZE, POLAR_SIZE],
          chunks: [
            [6656, 6912],
            [6656, 7680],
            [6656, 12800],
          ],
        },
        {
          description: "south polar stereographic to Web Mercator",
          source: "EPSG:3031",
          display: "EPSG:3857",
          grid: POLAR_GRID,
          size: [POLAR_SIZE, POLAR_SIZE],
          // Chunks closer to the pole lie beyond the latitude limit of Web Mercator, where the
          // interpolation error is not refined.
          chunks: [
            [6656, 8192],
            [6656, 9984],
          ],
        },
        {
          // The antimeridian runs from the pole diagonally towards -x, -y.
          description: "north polar stereographic to geographic",
          source: "EPSG:3413",
          display: "EPSG:4326",
          grid: POLAR_GRID,
          size: [POLAR_SIZE, POLAR_SIZE],
          chunks: [
            [6400, 6400],
            [5632, 5632],
          ],
        },
        {
          // Global quarter-degree grid with longitudes 0..360; 180 degrees lies at x = 720.5.
          description: "0..360 geographic grid to Equal Earth",
          source: "EPSG:4326",
          display: "EPSG:8857",
          grid: [0.25, 0, 0, -0.25, -0.125, 90.125],
          size: [1440, 721],
          chunks: [
            [512, 0],
            [512, 256],
            [512, 512],
          ],
        },
        {
          // Longitudes 170..190; 180 degrees lies at x = 1000.
          description: "geographic grid across the antimeridian to Equal Earth",
          source: "EPSG:4326",
          display: "EPSG:8857",
          grid: [0.01, 0, 0, -0.01, 170, 10],
          size: [2000, 1000],
          chunks: [
            [768, 0],
            [768, 768],
          ],
        },
        {
          description:
            "Web Mercator grid with cell centers on +/-180 to Equal Earth",
          source: "EPSG:3857",
          display: "EPSG:8857",
          grid: MERCATOR_OVERHANG_GRID,
          size: [1024, 1024],
          chunks: [
            [0, 256],
            [768, 512],
          ],
        },
      ];
      for (const {
        description,
        source,
        display,
        grid,
        size,
        chunks,
      } of cases) {
        const warp = makeWarp(source, display, grid, [0, 0], size);
        for (const [x0, y0] of chunks) {
          const x1 = Math.min(size[0], x0 + chunkSize);
          const y1 = Math.min(size[1], y0 + chunkSize);
          const mesh = computeWarpMesh(warp, x0, y0, x1, y1, { maxError: 0.2 });
          const message = `${description}: chunk ${x0},${y0}`;
          // Output coordinates are approximately source pixels; triangles straddling the
          // discontinuity would span a large fraction of the world.
          expect(getMaxTriangleExtent(mesh), message).toBeLessThan(
            4 * chunkSize,
          );
          // Only a thin gap is left along the discontinuity.
          expect(
            getCoveredFraction(mesh, x0, y0, x1, y1),
            message,
          ).toBeGreaterThan(0.995);
        }
      }
    },
  );

  it("does not fold sources slightly wider than 360 degrees", () => {
    // The edge columns extend half a pixel beyond +/-180 degrees, but are not discontinuous in a
    // periodic display CRS.
    for (const [source, grid, size] of [
      ["EPSG:3857", MERCATOR_OVERHANG_GRID, [1024, 1024]],
      [
        "EPSG:4087",
        [
          MERCATOR_PIXEL,
          0,
          0,
          -MERCATOR_PIXEL,
          -20037508.3428 - MERCATOR_PIXEL / 2,
          10018754.1714 + MERCATOR_PIXEL / 2,
        ],
        [1024, 512],
      ],
    ] as [string, Affine2d, [number, number]][]) {
      const warp = makeWarp(source, "EPSG:4326", grid, [0, 0], size);
      for (const x0 of [0, 768]) {
        const x1 = x0 + 256;
        const mesh = computeWarpMesh(warp, x0, 0, x1, 256, { maxError: 0.2 });
        expect(getMaxTriangleExtent(mesh), source).toBeLessThanOrEqual(256.5);
        expect(getCoveredFraction(mesh, x0, 0, x1, 256), source).toBeCloseTo(
          1,
          9,
        );
      }
      const bounds = computeWarpedBounds(warp, [0, 0], size)!;
      expect(bounds.lower[0], source).toBeCloseTo(0, 6);
      expect(bounds.upper[0], source).toBeCloseTo(size[0], 6);
    }
  });
});

describe("computeWarpMesh near invalid regions", () => {
  it("covers valid regions adjacent to invalid regions", () => {
    // Quarter-degree grid with cell centers on the poles (as for ERA5), such that the top edge of
    // the grid lies beyond the pole, displayed in Web Mercator.
    const warp = makeWarp(
      "EPSG:4326",
      "EPSG:3857",
      [0.25, 0, 0, -0.25, -180.125, 90.125],
      [0, 0],
      [1440, 721],
    );
    const mesh = computeWarpMesh(warp, 0, 0, 256, 256);
    const { indices, sourcePositions: p } = mesh;
    const contains = (x: number, y: number) => {
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
        const d = (px: number, py: number, qx: number, qy: number) =>
          (qx - px) * (y - py) - (qy - py) * (x - px);
        const d0 = d(p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]);
        const d1 = d(p[2 * b], p[2 * b + 1], p[2 * c], p[2 * c + 1]);
        const d2 = d(p[2 * c], p[2 * c + 1], p[2 * a], p[2 * a + 1]);
        if (
          (d0 >= 0 && d1 >= 0 && d2 >= 0) ||
          (d0 <= 0 && d1 <= 0 && d2 <= 0)
        ) {
          return true;
        }
      }
      return false;
    };
    // Latitude 80 (row 40.5) at various longitudes, near the clamped region.
    for (const x of [10, 64, 128, 200, 250]) {
      expect(contains(x, 40.5), `x=${x}`).toBe(true);
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

  it("linearizes away from singularities of the reprojection", () => {
    const cases: {
      description: string;
      source: string;
      display: string;
      grid: Affine2d;
      size: [number, number];
      // Approximate size of a pixel in display units.
      pixelSize: number;
    }[] = [
      {
        // The longitude is undefined at the pole, at the center of the source.
        description: "south polar stereographic to geographic",
        source: "EPSG:3031",
        display: "EPSG:4326",
        grid: POLAR_GRID,
        size: [POLAR_SIZE, POLAR_SIZE],
        pixelSize: 500 / 111320,
      },
      {
        description: "north polar stereographic to geographic",
        source: "EPSG:3413",
        display: "EPSG:4326",
        grid: POLAR_GRID,
        size: [POLAR_SIZE, POLAR_SIZE],
        pixelSize: 500 / 111320,
      },
      {
        // The center of the source lies on the antimeridian, where Equal Earth is discontinuous.
        description: "0..360 geographic grid to Equal Earth",
        source: "EPSG:4326",
        display: "EPSG:8857",
        grid: [0.25, 0, 0, -0.25, -0.125, 90.125],
        size: [1440, 721],
        pixelSize: 0.25 * 111320,
      },
      {
        description: "UTM to geographic",
        source: "EPSG:32633",
        display: "EPSG:4326",
        grid: SENTINEL_TILE,
        size: [SENTINEL_SIZE, SENTINEL_SIZE],
        pixelSize: 10 / 111320,
      },
    ];
    for (const {
      description,
      source,
      display,
      grid,
      size,
      pixelSize,
    } of cases) {
      const spec = computeGeoWarpSpec(
        getCrs(source),
        getCrs(display),
        [0, 1],
        grid,
        [0, 0],
        size,
      );
      const [a00, a10, a01, a11] = spec.multiscaleToDisplay;
      const scale = Math.sqrt(Math.abs(a00 * a11 - a01 * a10));
      expect(scale / pixelSize, description).toBeGreaterThan(0.25);
      expect(scale / pixelSize, description).toBeLessThan(4);
      // Well conditioned.
      const norm2 = a00 ** 2 + a10 ** 2 + a01 ** 2 + a11 ** 2;
      expect(scale ** 2 / norm2, description).toBeGreaterThan(0.01);
    }
  });

  // Computationally expensive.
  it(
    "computes warped bounds enclosing the interior and poles",
    { timeout: 60_000 },
    () => {
      for (const [source, display] of [
        ["EPSG:3413", "EPSG:3857"],
        ["EPSG:3031", "EPSG:4326"],
        ["EPSG:3031", "EPSG:3031"],
        ["EPSG:32633", "EPSG:4326"],
      ]) {
        const isPolar = source !== "EPSG:32633";
        const grid = isPolar ? POLAR_GRID : SENTINEL_TILE;
        const size = isPolar ? POLAR_SIZE : SENTINEL_SIZE;
        const warp = makeWarp(source, display, grid, [0, 0], [size, size]);
        const bounds = computeWarpedBounds(warp, [0, 0], [size, size])!;
        const samples: [number, number][] = [];
        const n = 100;
        for (let i = 0; i <= n; ++i) {
          for (let j = 0; j <= n; ++j) {
            samples.push([(i / n) * size, (j / n) * size]);
          }
        }
        // Points around the pole.
        for (let k = 0; k < 360; ++k) {
          const angle = (k * Math.PI) / 180;
          for (const r of [0.01, 0.5, 5]) {
            samples.push([
              size / 2 + 6 + r * Math.cos(angle),
              size / 2 + 6 + r * Math.sin(angle),
            ]);
          }
        }
        const out = new Float64Array(2);
        for (const [x, y] of samples) {
          if (warp.forward(x, y, out) === TransformStatus.INVALID) continue;
          const message = `${source} -> ${display}: ${x},${y}`;
          for (let i = 0; i < 2; ++i) {
            const tolerance = 1e-2 * (bounds.upper[i] - bounds.lower[i]);
            expect(out[i], message).toBeGreaterThanOrEqual(
              bounds.lower[i] - tolerance,
            );
            expect(out[i], message).toBeLessThanOrEqual(
              bounds.upper[i] + tolerance,
            );
          }
        }
      }
    },
  );

  it("excludes extremely distorted regions from warped bounds", () => {
    // A global grid shown in a north polar stereographic projection: the southern hemisphere
    // extends towards infinity, but the bounds should remain centered near the north pole.
    const warp = makeWarp(
      "EPSG:4326",
      "EPSG:3413",
      [0.25, 0, 0, -0.25, -180, 90],
      [0, 0],
      [1440, 720],
    );
    const bounds = computeWarpedBounds(warp, [0, 0], [1440, 720])!;
    const pole = new Float64Array(2);
    expect(warp.forward(720, 0, pole)).not.toBe(TransformStatus.INVALID);
    for (let i = 0; i < 2; ++i) {
      const width = bounds.upper[i] - bounds.lower[i];
      const center = (bounds.lower[i] + bounds.upper[i]) / 2;
      expect(Math.abs(pole[i] - center)).toBeLessThan(0.1 * width);
    }
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
