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
 * @file Viewer-level display coordinate reference system.
 */

import type { Crs } from "#src/geo/crs.js";
import { getCrs } from "#src/geo/crs.js";
import { TrackableValue } from "#src/trackable_value.js";
import { verifyString } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Names of the model dimensions holding display CRS x (easting/longitude) and y
 * (northing/latitude) coordinates of reprojected data sources, and of the corresponding global
 * dimensions.
 */
export const GEO_DIMENSION_NAMES: readonly [string, string] = ["x", "y"];

function validateCrsSpecification(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  const s = verifyString(x);
  return getCrs(s).id;
}

/**
 * Display CRS of the viewer, stored in the `"crs"` property of the viewer state.
 *
 * Georeferenced data sources are reprojected into this CRS.  If unspecified, it is set to the CRS
 * of the first georeferenced data source that is loaded.
 */
export class TrackableDisplayCrs extends TrackableValue<string | undefined> {
  /**
   * Names of the global dimensions holding display CRS x and y coordinates.
   */
  get dimensionNames(): readonly [string, string] {
    return GEO_DIMENSION_NAMES;
  }

  /**
   * Elevations (in meters, positive up) of the levels of vertical global dimensions, keyed by
   * dimension name, as reported by georeferenced data sources.
   */
  verticalAxes = new Map<string, number[]>();
  verticalAxesChanged = new NullarySignal();

  /**
   * Number of georeferenced data sources currently loaded.  Geospatial navigation and overlays
   * are only enabled while this is non-zero.
   */
  numGeoSources = 0;
  numGeoSourcesChanged = new NullarySignal();

  /**
   * Indicates that a georeferenced data source is loaded.  Returns a function that must be called
   * when it is unloaded.
   */
  retainGeoSource() {
    ++this.numGeoSources;
    this.numGeoSourcesChanged.dispatch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      --this.numGeoSources;
      this.numGeoSourcesChanged.dispatch();
    };
  }

  registerVerticalAxis(name: string, elevations: number[]) {
    const existing = this.verticalAxes.get(name);
    if (existing !== undefined && existing.length === elevations.length) return;
    this.verticalAxes.set(name, elevations);
    this.verticalAxesChanged.dispatch();
  }

  constructor() {
    super(undefined, validateCrsSpecification);
  }

  get crs(): Crs | undefined {
    const { value } = this;
    if (value === undefined) return undefined;
    return getCrs(value);
  }

  /**
   * Returns the display CRS, adopting `sourceCrs` if no display CRS has been set.
   */
  getOrAdopt(sourceCrs: string): Crs {
    let { value } = this;
    if (value === undefined) {
      value = this.value = getCrs(sourceCrs).id;
    }
    return getCrs(value!);
  }
}
