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
