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
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import { getCrs } from "#src/geo/crs.js";
import {
  classifyGeoPanelView,
  computeMapViewDepthRange,
  formatLatitudeLongitude,
  GEO_YZ_RELATIVE_ORIENTATION,
  getGeoDisplayInfo,
  getGroundMetersPerPixel,
  globalToLonLat,
  lonLatToGlobal,
  normalizeCrsPosition,
  NORTH_UP_ORIENTATION,
  restrictToMapPlane,
} from "#src/geo/geo_view.js";
import {
  chooseGraticuleSpacing,
  computeGraticule,
  computeNorthDirection,
  formatGraticuleLabel,
} from "#src/geo/graticule.js";
import { VerticalAxis } from "#src/geo/vertical.js";
import { mat4, quat, vec3 } from "#src/util/geom.js";

function makeInfo(crs: string, scale: number, unit: string) {
  const space = makeCoordinateSpace({
    names: ["x", "y", "z"],
    units: [unit, unit, ""],
    scales: Float64Array.of(scale, scale, 1),
  });
  return getGeoDisplayInfo(getCrs(crs), ["x", "y"], space)!;
}

/**
 * Returns the view parameters of a north-up orthographic cross section centered at `center`
 * (global voxel coordinates), with `unitsPerPixel` global voxels per pixel.
 */
function makeMapView(center: number[], unitsPerPixel: number, size = 400) {
  // Display coordinates -> clip coordinates: x right, y up (north-up flips y).
  const viewProjectionMat = mat4.create();
  const s = 2 / (size * unitsPerPixel);
  viewProjectionMat[0] = s;
  viewProjectionMat[5] = s;
  viewProjectionMat[10] = -1e-3;
  viewProjectionMat[12] = -s * center[0];
  viewProjectionMat[13] = -s * center[1];
  const invViewProjectionMat = mat4.invert(mat4.create(), viewProjectionMat)!;
  return {
    width: size,
    height: size,
    viewProjectionMat,
    invViewProjectionMat,
    displayDimensionIndices: Int32Array.of(0, 1, 2),
    globalPosition: Float32Array.from(center),
  };
}

describe("geo display info", () => {
  it("converts between global positions and geographic coordinates", () => {
    const cases: [string, number, string, number, number][] = [
      ["EPSG:4326", 0.001, "deg", 13.4, 52.5],
      ["EPSG:3857", 10, "m", -70, 37],
      ["EPSG:3413", 100, "m", -45, 80],
    ];
    for (const [crs, scale, unit, lon, lat] of cases) {
      const info = makeInfo(crs, scale, unit);
      const position = new Float64Array(3);
      expect(lonLatToGlobal(info, lon, lat, position), crs).toBe(true);
      const lonLat = new Float64Array(2);
      expect(globalToLonLat(info, position, lonLat), crs).toBe(true);
      expect(lonLat[0], crs).toBeCloseTo(lon, 6);
      expect(lonLat[1], crs).toBeCloseTo(lat, 6);
    }
  });

  it("requires the display CRS dimensions with matching units", () => {
    const space = makeCoordinateSpace({
      names: ["x", "y"],
      units: ["m", "m"],
      scales: Float64Array.of(1, 1),
    });
    expect(getGeoDisplayInfo(getCrs("EPSG:4326"), ["x", "y"], space)).toBe(
      undefined,
    );
    expect(getGeoDisplayInfo(getCrs("EPSG:3857"), ["lon", "lat"], space)).toBe(
      undefined,
    );
  });

  it("computes ground distance per pixel", () => {
    // Plate carree at 60 degrees latitude: east-west distances are halved.
    const info = makeInfo("EPSG:4326", 0.001, "deg");
    const invViewMatrix = mat4.create();
    const result = getGroundMetersPerPixel(
      info,
      [0, 60000, 0],
      invViewMatrix,
      [0, 1, 2],
    )!;
    expect(result[1]).toBeCloseTo(111.195, 1);
    expect(result[0]! / result[1]!).toBeCloseTo(0.5, 3);
  });
});

describe("geo navigation", () => {
  it("wraps longitude and clamps latitude", () => {
    const cases: [string, number, number, [number, number] | undefined][] = [
      ["EPSG:4326", 190, 10, [-170, 10]],
      ["EPSG:4326", -540, 95, [-180, 90]],
      ["EPSG:4326", 10, 10, undefined],
      ["EPSG:3857", 21000000, 0, [21000000 - 2 * Math.PI * 6378137, 0]],
      ["EPSG:32633", 1e7, 1e8, undefined],
    ];
    for (const [crs, x, y, expected] of cases) {
      const result = normalizeCrsPosition(getCrs(crs), x, y);
      if (expected === undefined) {
        expect(result, crs).toBe(undefined);
      } else {
        expect(result![0], crs).toBeCloseTo(expected[0], 3);
        expect(result![1], crs).toBeCloseTo(expected[1], 3);
      }
    }
  });

  it("restricts orientations to rotations within the map plane", () => {
    const twisted = quat.multiply(
      quat.create(),
      NORTH_UP_ORIENTATION,
      quat.setAxisAngle(quat.create(), [0, 0, 1], 0.3),
    );
    // Already in the map plane: unchanged.
    const q = quat.clone(twisted);
    expect(restrictToMapPlane(q)).toBe(false);
    // Tilted out of the map plane: the tilt is removed, the twist preserved.
    const tilted = quat.multiply(
      quat.create(),
      twisted,
      quat.setAxisAngle(quat.create(), [1, 0, 0], 0.4),
    );
    expect(restrictToMapPlane(tilted)).toBe(true);
    for (let i = 0; i < 4; ++i) {
      expect(Math.abs(tilted[i])).toBeCloseTo(Math.abs(twisted[i]), 5);
    }
    // Identity orientation becomes north-up.
    const identity = quat.create();
    expect(restrictToMapPlane(identity)).toBe(true);
    expect(Array.from(identity)).toEqual(Array.from(NORTH_UP_ORIENTATION));
  });

  it("orients north-south sections with north right and up upward", () => {
    const orientation = quat.multiply(
      quat.create(),
      NORTH_UP_ORIENTATION,
      GEO_YZ_RELATIVE_ORIENTATION,
    );
    const map = (v: [number, number, number]) =>
      Array.from(
        vec3.transformQuat(
          vec3.create(),
          vec3.fromValues(v[0], v[1], v[2]),
          orientation,
        ),
      ).map((x) => Math.round(x * 1e6) / 1e6 + 0);
    // View x (right) is north, view y (down) is down, view z (into the screen) is west.
    expect(map([1, 0, 0])).toEqual([0, 1, 0]);
    expect(map([0, 1, 0])).toEqual([0, 0, -1]);
    expect(map([0, 0, 1])).toEqual([-1, 0, 0]);
  });

  it("formats geographic coordinates", () => {
    expect(formatLatitudeLongitude(37.5, true)).toBe("37.50000°N");
    expect(formatLatitudeLongitude(-12.25, true, 2)).toBe("12.25°S");
    expect(formatLatitudeLongitude(190, false, 1)).toBe("170.0°W");
    expect(formatLatitudeLongitude(15, false, 0)).toBe("15°E");
  });

  it("classifies cross sections", () => {
    const info = makeInfo("EPSG:4326", 0.001, "deg");
    const axis = new VerticalAxis([-100, -50, -10]);
    const getVerticalAxis = (dim: number) => (dim === 2 ? axis : undefined);
    const map = mat4.create();
    expect(classifyGeoPanelView(info, getVerticalAxis, map, [0, 1, 2])).toEqual(
      { kind: "map" },
    );
    // Rotated 90 degrees about x: the y axis becomes the normal.
    const section = mat4.fromXRotation(mat4.create(), Math.PI / 2);
    expect(
      classifyGeoPanelView(info, getVerticalAxis, section, [0, 1, 2]),
    ).toEqual({
      kind: "vertical",
      axis,
      verticalDisplayDimension: 2,
      verticalGlobalDimension: 2,
    });
    // The vertical dimension may have a much larger display scale than the horizontal ones, which
    // amplifies rounding error in the normal.
    const scaledSection = mat4.multiply(
      mat4.create(),
      section,
      mat4.fromScaling(mat4.create(), [1, 1, 1e5]),
    );
    scaledSection[6] = 1;
    scaledSection[10] = 4e-3;
    expect(
      classifyGeoPanelView(info, getVerticalAxis, scaledSection, [0, 1, 2]),
    ).toEqual({
      kind: "vertical",
      axis,
      verticalDisplayDimension: 2,
      verticalGlobalDimension: 2,
    });
    // Without a vertical axis, the section is not classified.
    expect(
      classifyGeoPanelView(info, () => undefined, section, [0, 1, 2]),
    ).toBe(undefined);
  });

  it("computes the depth range of map views spanning vertical dimensions", () => {
    const info = makeInfo("EPSG:4326", 0.001, "deg");
    const axis = new VerticalAxis([-950, -850, -750, -650]);
    const getVerticalAxis = (dim: number) => (dim === 2 ? axis : undefined);
    // Map view with 10 view units per vertical voxel, positioned at level 1.
    const map = mat4.fromScaling(mat4.create(), [1, 1, 10]);
    const range = computeMapViewDepthRange(
      info,
      getVerticalAxis,
      map,
      [0, 1, 2],
      [0, 0, 1],
    )!;
    // Must span the farthest level boundary (3 voxels away).
    expect(range).toBeGreaterThanOrEqual(30);
    // Not a map view, or no vertical axis: undefined.
    const section = mat4.fromXRotation(mat4.create(), Math.PI / 2);
    expect(
      computeMapViewDepthRange(
        info,
        getVerticalAxis,
        section,
        [0, 1, 2],
        [0, 0, 1],
      ),
    ).toBe(undefined);
    expect(
      computeMapViewDepthRange(
        info,
        () => undefined,
        map,
        [0, 1, 2],
        [0, 0, 1],
      ),
    ).toBe(undefined);
  });
});

describe("graticule", () => {
  it("chooses spacing and formats labels", () => {
    expect(chooseGraticuleSpacing(180)).toBe(45);
    expect(chooseGraticuleSpacing(2)).toBe(0.5);
    expect(chooseGraticuleSpacing(0.03)).toBe(0.01);
    expect(formatGraticuleLabel(15, false, 5)).toBe("15°E");
    expect(formatGraticuleLabel(-37.5, true, 0.5)).toBe("37.5°S");
    expect(formatGraticuleLabel(180, false, 30)).toBe("180°");
    expect(formatGraticuleLabel(0, true, 10)).toBe("0°");
    expect(formatGraticuleLabel(370, false, 10)).toBe("10°E");
  });

  it("computes labeled lines within the viewport", () => {
    // 4 x 4 degree view centered at (10E, 50N) in plate carree.
    const info = makeInfo("EPSG:4326", 0.001, "deg");
    const view = makeMapView([10000, 50000, 0], 10);
    const graticule = computeGraticule(info, view)!;
    expect(graticule.latitudeSpacing).toBe(1);
    const meridians = graticule.lines
      .filter((l) => l.isMeridian)
      .map((l) => l.value);
    expect(meridians).toEqual(expect.arrayContaining([9, 10, 11]));
    const meridianLabels = graticule.labels
      .filter((l) => l.edge === "bottom")
      .map((l) => l.text);
    expect(meridianLabels).toEqual(
      expect.arrayContaining(["9°E", "10°E", "11°E"]),
    );
    // The 10E meridian passes through the center of the view.
    const label10 = graticule.labels.find((l) => l.text === "10°E")!;
    expect(label10.x).toBeCloseTo(200, 1);
    expect(computeNorthDirection(info, view)).toBeCloseTo(0, 6);
  });
});
