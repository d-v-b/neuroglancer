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
import {
  clipLineToViewport,
  clipViewportToHalfPlane,
  formatElevation,
  getScreenToVerticalCoordinate,
  VerticalAxis,
} from "#src/geo/vertical.js";
import { mat4 } from "#src/util/geom.js";

describe("VerticalAxis", () => {
  it("maps between coordinates and elevations", () => {
    // Ascending (deepest level first), as in Copernicus Marine "elevation".
    const ascending = new VerticalAxis([-1000, -100, -10, -1]);
    // Descending (shallowest level first), as for "depth" coordinates.
    const descending = new VerticalAxis([-1, -10, -100, -1000]);
    const cases: [VerticalAxis, number, number][] = [
      [ascending, 0.5, -1000],
      [ascending, 1.5, -100],
      [ascending, 2, -55],
      [ascending, 3.5, -1],
      [ascending, 4, 3.5],
      [descending, 0.5, -1],
      [descending, 0, 3.5],
      [descending, 3.5, -1000],
    ];
    for (const [axis, coordinate, elevation] of cases) {
      expect(axis.coordinateToElevation(coordinate)).toBeCloseTo(elevation, 6);
      expect(axis.elevationToCoordinate(elevation)).toBeCloseTo(coordinate, 6);
    }
    expect(ascending.ascending).toBe(true);
    expect(descending.ascending).toBe(false);
    expect(ascending.elevationRange).toEqual([-1450, 3.5]);
  });

  it("rejects axes with fewer than 2 levels", () => {
    expect(() => new VerticalAxis([-5])).toThrow(/at least 2 levels/);
  });

  it("formats elevations as depths", () => {
    expect(formatElevation(-200)).toBe("200 m");
    expect(formatElevation(-1500)).toBe("1.5 km");
    expect(formatElevation(1000)).toBe("+1 km");
  });
});

describe("vertical section geometry", () => {
  it("clips the viewport to half-planes and lines", () => {
    // Half-plane y <= 30 (i.e. -y + 30 >= 0) of a 100 x 50 viewport.
    expect(clipViewportToHalfPlane(100, 50, 0, -1, 30)).toEqual([
      0, 0, 100, 0, 100, 30, 0, 30,
    ]);
    expect(clipViewportToHalfPlane(100, 50, 0, -1, -10)).toEqual([]);
    expect(clipLineToViewport(100, 50, 0, 1, -20)).toEqual([0, 20, 100, 20]);
    expect(clipLineToViewport(100, 50, 1, 0, -40)).toEqual([40, 0, 40, 50]);
    expect(clipLineToViewport(100, 50, 0, 1, 10)).toBe(undefined);
  });

  it("maps screen positions to the vertical coordinate", () => {
    // Display dimension 2 (vertical) maps to clip y with 10 levels per viewport height.
    const viewProjection = mat4.create();
    viewProjection[0] = 0;
    viewProjection[5] = 0;
    viewProjection[8] = 0;
    viewProjection[4] = 0;
    // clip x = display x / 100, clip y = (display z - 5) / 5, clip z = display y.
    viewProjection.set([0.01, 0, 0, 0, 0, 0, 1, 0, 0, 0.2, 0, 0, 0, -1, 0, 1]);
    const inv = mat4.invert(mat4.create(), viewProjection)!;
    const [a, b, c] = getScreenToVerticalCoordinate({
      width: 200,
      height: 100,
      invViewProjectionMat: inv,
      verticalDisplayDimension: 2,
    });
    // Top of the screen is coordinate 10, bottom is 0.
    expect(a).toBeCloseTo(0, 9);
    expect(c).toBeCloseTo(10, 9);
    expect(b * 100 + c).toBeCloseTo(0, 9);
  });
});
