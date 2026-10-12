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
  makeCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/coordinate_transform.js";
import { getCrs } from "#src/geo/crs.js";
import { TrackableDisplayCrs } from "#src/geo/display_crs.js";
import {
  classifyGeoPanelView,
  computeMapViewDepthRange,
  formatLatitudeLongitude,
  GEO_YZ_RELATIVE_ORIENTATION,
  GeoViewState,
  getGeoDisplayInfo,
  getGeoYzRelativeOrientation,
  getGroundMetersPerPixel,
  getNorthUpOrientation,
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
import {
  DisplayPose,
  NavigationState,
  OrientationState,
  Position,
  TrackableCrossSectionZoom,
  TrackableDepthRange,
  TrackableDisplayDimensions,
  TrackableProjectionZoom,
  TrackableRelativeDisplayScales,
  WatchableDisplayDimensionRenderInfo,
} from "#src/navigation_state.js";
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

/**
 * Maps a view direction to display coordinates (rounded) using `orientation`.
 */
function mapViewDirection(orientation: quat, v: [number, number, number]) {
  return Array.from(
    vec3.transformQuat(vec3.create(), vec3.fromValues(...v), orientation),
  ).map((x) => Math.round(x * 1e6) / 1e6 + 0);
}

function expectSameRotation(a: quat, b: quat) {
  const sign = Math.sign(quat.dot(a, b)) || 1;
  for (let i = 0; i < 4; ++i) {
    expect(a[i]).toBeCloseTo(sign * b[i], 6);
  }
}

describe("geo orientation", () => {
  it("orients north-up and north-south sections for any display dimension order", () => {
    expectSameRotation(getNorthUpOrientation(0, 1), NORTH_UP_ORIENTATION);
    expectSameRotation(
      getGeoYzRelativeOrientation(0, 1),
      GEO_YZ_RELATIVE_ORIENTATION,
    );
    for (const [xDisplay, yDisplay] of [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 1],
    ]) {
      const unit = (d: number, sign = 1) => {
        const v = [0, 0, 0];
        v[d] = sign;
        return v;
      };
      const label = `${xDisplay},${yDisplay}`;
      const northUp = getNorthUpOrientation(xDisplay, yDisplay);
      // Screen right is east, screen down is south.
      expect(mapViewDirection(northUp, [1, 0, 0]), label).toEqual(
        unit(xDisplay),
      );
      expect(mapViewDirection(northUp, [0, 1, 0]), label).toEqual(
        unit(yDisplay, -1),
      );
      // Screen right is north, screen down is down along the remaining display dimension.
      const section = quat.multiply(
        quat.create(),
        northUp,
        getGeoYzRelativeOrientation(xDisplay, yDisplay),
      );
      expect(mapViewDirection(section, [1, 0, 0]), label).toEqual(
        unit(yDisplay),
      );
      expect(mapViewDirection(section, [0, 1, 0]), label).toEqual(
        unit(3 - xDisplay - yDisplay, -1),
      );
      // The map plane restriction preserves the north-up orientation.
      expect(restrictToMapPlane(quat.clone(northUp), northUp), label).toBe(
        false,
      );
    }
  });
});

function makeGeoViewState(space: {
  names: string[];
  units: string[];
  scales: number[];
  ids?: number[];
}) {
  const coordinateSpace = new TrackableCoordinateSpace();
  coordinateSpace.value = makeCoordinateSpace({
    ...space,
    scales: Float64Array.from(space.scales),
  });
  const position = new Position(coordinateSpace);
  const displayDimensions = new TrackableDisplayDimensions(coordinateSpace);
  const renderInfo = new WatchableDisplayDimensionRenderInfo(
    new TrackableRelativeDisplayScales(coordinateSpace),
    displayDimensions,
  );
  const navigationState = new NavigationState(
    new DisplayPose(position, renderInfo, new OrientationState()),
    new TrackableCrossSectionZoom(renderInfo.addRef()),
    new TrackableDepthRange(-10, renderInfo),
  );
  const displayCrs = new TrackableDisplayCrs();
  const geoView = new GeoViewState(
    displayCrs,
    coordinateSpace,
    navigationState,
  );
  return {
    coordinateSpace,
    position,
    displayDimensions,
    renderInfo,
    navigationState,
    orientation: navigationState.pose.orientation,
    displayCrs,
    geoView,
  };
}

function getLonLat(geoView: GeoViewState, position: Position) {
  const out = new Float64Array(2);
  expect(globalToLonLat(geoView.info!, position.value, out)).toBe(true);
  return Array.from(out);
}

describe("GeoViewState", () => {
  it("keeps the position when the coordinate space changes", () => {
    const { coordinateSpace, position, displayCrs, geoView } = makeGeoViewState(
      {
        names: ["t", "x", "y"],
        units: ["s", "deg", "deg"],
        scales: [1, 1e-3, 1e-3],
        ids: [1, 2, 3],
      },
    );
    displayCrs.value = "EPSG:4326";
    displayCrs.retainGeoSource();
    position.restoreState([5, 100000, 40000]);
    // Scale change of the display CRS dimensions.
    coordinateSpace.value = makeCoordinateSpace({
      names: ["t", "x", "y"],
      units: ["s", "deg", "deg"],
      scales: Float64Array.of(1, 1e-4, 1e-4),
      ids: [1, 2, 3],
    });
    expect(Array.from(position.value)).toEqual([5, 1000000, 400000]);
    // Removal of a dimension preceding the display CRS dimensions.
    coordinateSpace.value = makeCoordinateSpace({
      names: ["x", "y"],
      units: ["deg", "deg"],
      scales: Float64Array.of(1e-4, 1e-4),
      ids: [2, 3],
    });
    expect(Array.from(position.value)).toEqual([1000000, 400000]);
    expect(getLonLat(geoView, position)).toEqual([100, 40]);
  });

  it("restricts rotations of north-south sections to the map plane", () => {
    const { orientation, displayCrs, geoView } = makeGeoViewState({
      names: ["x", "y", "z"],
      units: ["deg", "deg", "m"],
      scales: [1e-3, 1e-3, 1],
    });
    displayCrs.value = "EPSG:4326";
    displayCrs.retainGeoSource();
    expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
    const relative = geoView.getYzRelativeOrientation()!;
    const section = OrientationState.makeRelative(orientation, relative);
    // Tilt the section about the north axis, which would tilt the map plane.
    quat.rotateX(section.orientation, section.orientation, 0.7);
    section.changed.dispatch();
    expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
    expectSameRotation(
      section.orientation,
      quat.multiply(quat.create(), orientation.orientation, relative),
    );
  });

  it("orients north-up when a geospatial display is established again", () => {
    const { navigationState, orientation, displayCrs } = makeGeoViewState({
      names: ["x", "y"],
      units: ["deg", "deg"],
      scales: [1e-3, 1e-3],
    });
    displayCrs.value = "EPSG:4326";
    const release = displayCrs.retainGeoSource();
    expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
    // Reset while no georeferenced data source is loaded.
    release();
    navigationState.reset();
    expectSameRotation(orientation.orientation, quat.create());
    displayCrs.retainGeoSource();
    expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
  });

  it("displays the display CRS dimensions north-up regardless of their order", () => {
    const space = {
      names: ["time", "depth", "y", "x"],
      units: ["s", "m", "deg", "deg"],
      scales: [1, 1, 1e-3, 1e-3],
    };
    // Default display dimensions (the first three) are replaced.
    {
      const { displayDimensions, orientation, displayCrs } =
        makeGeoViewState(space);
      displayCrs.value = "EPSG:4326";
      displayCrs.registerVerticalAxis("depth", [-5, -15, -25]);
      displayCrs.retainGeoSource();
      const { displayRank, displayDimensionIndices } = displayDimensions.value;
      expect(displayRank).toBe(3);
      expect(Array.from(displayDimensionIndices)).toEqual([3, 2, 1]);
      expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
    }
    // Explicitly specified display dimensions including both are kept.
    {
      const { displayDimensions, orientation, displayCrs } =
        makeGeoViewState(space);
      displayDimensions.setDimensionIndices(3, Int32Array.of(2, 3, 1));
      displayCrs.value = "EPSG:4326";
      displayCrs.retainGeoSource();
      expect(
        Array.from(displayDimensions.value.displayDimensionIndices),
      ).toEqual([2, 3, 1]);
      expectSameRotation(orientation.orientation, getNorthUpOrientation(1, 0));
    }
    // Default display dimensions in the order (y, x) are reordered.
    {
      const { displayDimensions, orientation, displayCrs } = makeGeoViewState({
        names: ["y", "x"],
        units: ["deg", "deg"],
        scales: [1e-3, 1e-3],
      });
      displayCrs.value = "EPSG:4326";
      displayCrs.retainGeoSource();
      const { displayRank, displayDimensionIndices } = displayDimensions.value;
      expect(displayRank).toBe(2);
      expect(Array.from(displayDimensionIndices)).toEqual([1, 0, -1]);
      expectSameRotation(orientation.orientation, NORTH_UP_ORIENTATION);
    }
  });

  it("preserves the location and ground resolution when changing the display CRS", () => {
    const {
      coordinateSpace,
      position,
      renderInfo,
      navigationState,
      displayCrs,
      geoView,
    } = makeGeoViewState({
      names: ["x", "y"],
      units: ["deg", "deg"],
      scales: [1e-3, 1e-3],
    });
    displayCrs.value = "EPSG:4326";
    const release = displayCrs.retainGeoSource();
    position.restoreState([13400, 52500]);
    navigationState.zoomFactor.value = 500;
    const projectionZoom = new TrackableProjectionZoom(renderInfo.addRef());
    projectionZoom.value = 1000;
    const otherPosition = new Position(coordinateSpace);
    otherPosition.restoreState([-70000, 37000]);
    geoView.registerNavigationTarget(() => ({
      position: otherPosition,
      zooms: [projectionZoom],
    }));
    const metersPerDegree = getCrs("EPSG:4326").metersPerUnit;
    const getPhysicalZoom = (zoom: { value: number }) =>
      zoom.value * renderInfo.value.canonicalVoxelPhysicalSize;
    geoView.setDisplayCrs("EPSG:3857");
    expect(coordinateSpace.value.units).toEqual(["m", "m"]);
    const lonLat = getLonLat(geoView, position);
    expect(lonLat[0]).toBeCloseTo(13.4, 4);
    expect(lonLat[1]).toBeCloseTo(52.5, 4);
    const otherLonLat = getLonLat(geoView, otherPosition);
    expect(otherLonLat[0]).toBeCloseTo(-70, 4);
    expect(otherLonLat[1]).toBeCloseTo(37, 4);
    // Mercator scale equals the plate carree scale in the east-west direction.
    expect(
      getPhysicalZoom(navigationState.zoomFactor) / (0.5 * metersPerDegree),
    ).toBeCloseTo(1, 3);
    expect(getPhysicalZoom(projectionZoom) / metersPerDegree).toBeCloseTo(1, 3);
    // Changing back while no georeferenced data source is loaded (e.g. while reprojecting) also
    // converts the units.
    release();
    geoView.setDisplayCrs("EPSG:4326");
    expect(coordinateSpace.value.units).toEqual(["deg", "deg"]);
    displayCrs.retainGeoSource();
    expect(geoView.info).toBeDefined();
    const restored = getLonLat(geoView, position);
    expect(restored[0]).toBeCloseTo(13.4, 4);
    expect(restored[1]).toBeCloseTo(52.5, 4);
  });

  it("converts the scales of vertical dimensions when changing the display CRS", () => {
    const { coordinateSpace, displayCrs, geoView } = makeGeoViewState({
      names: ["x", "y", "depth"],
      units: ["deg", "deg", "m"],
      scales: [1e-3, 1e-3, 1e-5],
    });
    displayCrs.value = "EPSG:4326";
    const releaseAxis = displayCrs.registerVerticalAxis("depth", [-5, -15]);
    const releaseSource = displayCrs.retainGeoSource();
    geoView.setDisplayCrs("EPSG:3857");
    const conversion = getCrs("EPSG:4326").metersPerUnit;
    expect(coordinateSpace.value.scales[2]).toBeCloseTo(1e-5 * conversion, 8);
    // Changing back while the data source is unloaded.
    releaseAxis();
    releaseSource();
    geoView.setDisplayCrs("EPSG:4326");
    expect(coordinateSpace.value.scales[2]).toBeCloseTo(1e-5, 12);
  });

  it("rejects display CRSs with units other than metres or degrees", () => {
    const { coordinateSpace, displayCrs, geoView } = makeGeoViewState({
      names: ["x", "y"],
      units: ["deg", "deg"],
      scales: [1e-3, 1e-3],
    });
    displayCrs.value = "EPSG:4326";
    displayCrs.retainGeoSource();
    expect(() =>
      geoView.setDisplayCrs(
        "+proj=tmerc +lat_0=0 +lon_0=-120 +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs",
      ),
    ).toThrow(/metres or degrees/);
    expect(displayCrs.value).toBe("EPSG:4326");
    expect(coordinateSpace.value.units).toEqual(["deg", "deg"]);
  });
});
