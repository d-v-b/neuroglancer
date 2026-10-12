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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeCoordinateSpace,
  WatchableCoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  FALLBACK_DISPLAY_CRS,
  getDisplayCrs,
  stripDisplayCrsDimensionsFromTransformSpecification,
  TrackableDisplayCrs,
} from "#src/geo/display_crs.js";

const US_FEET_CRS =
  "+proj=tmerc +lat_0=0 +lon_0=-120 +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft +no_defs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TrackableDisplayCrs", () => {
  it("adopts the CRS of the first georeferenced data source", () => {
    const cases: [string, string][] = [
      ["EPSG:3857", "EPSG:3857"],
      // Units other than metres or degrees are not supported for display.
      [US_FEET_CRS, FALLBACK_DISPLAY_CRS],
    ];
    for (const [sourceCrs, expected] of cases) {
      const displayCrs = new TrackableDisplayCrs();
      expect(displayCrs.getOrAdopt(sourceCrs).id).toBe(expected);
      expect(displayCrs.value).toBe(expected);
      expect(displayCrs.adopted).toBe(true);
      // Subsequent data sources use the adopted CRS.
      expect(displayCrs.getOrAdopt("EPSG:32633").id).toBe(expected);
      // The adopted CRS is cleared when the last georeferenced data source is unloaded.
      const release = displayCrs.retainGeoSource();
      release();
      expect(displayCrs.value).toBe(undefined);
    }
    // An explicitly specified CRS is kept.
    const displayCrs = new TrackableDisplayCrs();
    displayCrs.restoreState("EPSG:3413");
    expect(displayCrs.getOrAdopt("EPSG:3857").id).toBe("EPSG:3413");
    displayCrs.retainGeoSource()();
    expect(displayCrs.value).toBe("EPSG:3413");
    // Restoring a state without a display CRS keeps the current one, but treats it as adopted.
    let changes = 0;
    displayCrs.changed.add(() => ++changes);
    displayCrs.restoreState(undefined);
    expect(displayCrs.value).toBe("EPSG:3413");
    expect(changes).toBe(0);
    displayCrs.retainGeoSource()();
    expect(displayCrs.value).toBe(undefined);
  });

  it("rejects display CRSs with units other than metres or degrees", () => {
    expect(() => getDisplayCrs(US_FEET_CRS)).toThrow(/metres or degrees/);
    const displayCrs = new TrackableDisplayCrs();
    displayCrs.restoreState(US_FEET_CRS);
    expect(displayCrs.value).toBe(undefined);
  });

  it("tracks registrations of vertical axes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const displayCrs = new TrackableDisplayCrs();
    const a = [-5, -15, -25];
    const b = [-100, -200, -300];
    const releaseA1 = displayCrs.registerVerticalAxis("depth", a);
    // Equal elevations share the registration.
    const releaseA2 = displayCrs.registerVerticalAxis("depth", [...a]);
    expect(displayCrs.verticalAxes.get("depth")).toBe(a);
    expect(warn).not.toHaveBeenCalled();
    // Different elevations with the same number of levels: the most recent one is used.
    const releaseB = displayCrs.registerVerticalAxis("depth", b);
    expect(displayCrs.verticalAxes.get("depth")).toBe(b);
    expect(warn).toHaveBeenCalledTimes(1);
    releaseB();
    expect(displayCrs.verticalAxes.get("depth")).toBe(a);
    releaseA1();
    expect(displayCrs.verticalAxes.get("depth")).toBe(a);
    releaseA2();
    expect(displayCrs.verticalAxes.has("depth")).toBe(false);
  });
});

describe("stripDisplayCrsDimensionsFromTransformSpecification", () => {
  function makeDefaultTransform(unit: string, scale: number) {
    // Source dimensions (i, j, t) map to model dimensions (x, y, t).
    const space = (names: string[]) =>
      makeCoordinateSpace({
        names,
        units: [unit, unit, "s"],
        scales: Float64Array.of(scale, scale, 1),
      });
    const transform = new Float64Array(16);
    transform[0] = transform[5] = transform[10] = transform[15] = 1;
    return {
      rank: 3,
      sourceRank: 3,
      inputSpace: space(["i", "j", "t"]),
      outputSpace: space(["x", "y", "t"]),
      transform,
    };
  }

  it("preserves customizations of other dimensions", () => {
    const oldDefault = makeDefaultTransform("deg", 1e-3);
    const transform = new WatchableCoordinateSpaceTransform(oldDefault);
    // Rename and offset the time dimension, and offset the x dimension.
    const matrix = new Float64Array(oldDefault.transform);
    matrix[12] = 5;
    matrix[14] = 7;
    transform.spec = {
      sourceRank: 3,
      transform: matrix,
      inputSpace: undefined,
      outputSpace: makeCoordinateSpace({
        names: ["x", "y", "time"],
        units: ["deg", "deg", "s"],
        scales: Float64Array.of(1e-3, 1e-3, 1),
      }),
    };
    const stripped = stripDisplayCrsDimensionsFromTransformSpecification(
      transform.spec!,
      oldDefault,
      [0, 1],
    );
    expect(stripped.sourceRank).toBe(1);
    expect(stripped.outputSpace.names).toEqual(["time"]);
    const newDefault = makeDefaultTransform("m", 100);
    const reprojected = new WatchableCoordinateSpaceTransform(newDefault);
    reprojected.spec = stripped;
    const { outputSpace, transform: newMatrix } = reprojected.value;
    expect(outputSpace.names).toEqual(["x", "y", "time"]);
    expect(outputSpace.units).toEqual(["m", "m", "s"]);
    expect(Array.from(outputSpace.scales)).toEqual([100, 100, 1]);
    // The time offset is preserved; the x offset (in degrees) is dropped.
    expect(Array.from(newMatrix.subarray(12, 15))).toEqual([0, 0, 7]);
    // Specifications without customized display CRS dimensions are unchanged.
    const unchanged = {
      sourceRank: 1,
      transform: undefined,
      inputSpace: undefined,
      outputSpace: makeCoordinateSpace({
        names: ["time"],
        units: ["s"],
        scales: Float64Array.of(1),
      }),
    };
    expect(
      stripDisplayCrsDimensionsFromTransformSpecification(
        unchanged,
        makeDefaultTransform("m", 1),
        [],
      ),
    ).toBe(unchanged);
  });
});
