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

import { describe, expect, it, vi } from "vitest";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type { DataSource } from "#src/datasource/index.js";
import { getCrs } from "#src/geo/crs.js";
import { reprojectDataSource } from "#src/geo/reproject_data_source.js";

// The volume chunk source frontend depends on WebGL, which is not available in Node.
vi.mock("#src/sliceview/volume/frontend.js", () => ({
  MultiscaleVolumeChunkSource: class {},
}));

/**
 * Returns a data source for a 0.1-degree global geographic grid with a static annotation
 * subsource.
 */
function makeGeographicDataSource(): DataSource {
  const inputSpace = makeCoordinateSpace({
    names: ["x", "y"],
    units: ["", ""],
    scales: Float64Array.of(1, 1),
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: Float64Array.of(0, 0),
        upperBounds: Float64Array.of(3600, 1800),
      }),
    ],
  });
  const outputSpace = makeCoordinateSpace({
    names: ["lon", "lat"],
    units: ["", ""],
    scales: Float64Array.of(1, 1),
  });
  return {
    modelTransform: {
      rank: 2,
      sourceRank: 2,
      inputSpace,
      outputSpace,
      transform: Float64Array.of(0.1, 0, 0, 0, -0.1, 0, -180, 90, 1),
    },
    subsources: [
      {
        id: "bounds",
        default: true,
        subsource: { staticAnnotations: {} as any },
      },
      { id: "other", default: true, subsource: {} },
    ],
    geoReference: { crs: "EPSG:4326", modelDimensions: [0, 1] },
  };
}

describe("reprojectDataSource", () => {
  it("retains geometric subsources only for identity reprojections", () => {
    for (const [displayCrs, expectedIds, expectedDropped] of [
      ["EPSG:4326", ["bounds", "other"], []],
      ["EPSG:3857", ["other"], ["bounds"]],
    ] as [string, string[], string[]][]) {
      const result = reprojectDataSource(
        makeGeographicDataSource(),
        getCrs(displayCrs),
      );
      expect(
        result.subsources.map((entry) => entry.id),
        displayCrs,
      ).toEqual(expectedIds);
      expect(result.reprojection.droppedSubsources, displayCrs).toEqual(
        expectedDropped,
      );
    }
  });

  it("rejects display CRSs with unsupported units", () => {
    expect(() =>
      reprojectDataSource(
        makeGeographicDataSource(),
        getCrs(
          "+proj=tmerc +lat_0=0 +lon_0=-120 +k=1 +x_0=0 +y_0=0 +datum=NAD83 +units=us-ft",
        ),
      ),
    ).toThrow(/must have units of meters or degrees/);
  });
});
