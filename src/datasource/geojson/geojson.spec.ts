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
import type { Point, PolyLine } from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import {
  elevationToGeoJsonVerticalCoordinate,
  GEOJSON_VERTICAL_ELEVATIONS,
  getGeoJsonDataSource,
  getGeoJsonDefaultShader,
  makeGeoJsonAnnotationSource,
  parseGeoJsonOptions,
} from "#src/datasource/geojson/frontend.js";
import {
  inferVerticalCoordinate,
  isGeoJson,
  parseGeoJson,
  sanitizePropertyIdentifier,
} from "#src/datasource/geojson/parse.js";
import { TransformStatus } from "#src/geo/transform.js";

const EARTHQUAKES = {
  type: "FeatureCollection",
  metadata: {
    url: "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson",
  },
  features: [
    {
      type: "Feature",
      properties: { mag: 7.1, place: "Tonga", tsunami: 0, type: "earthquake" },
      geometry: { type: "Point", coordinates: [-178, -20, 600] },
    },
    {
      type: "Feature",
      properties: { mag: 6.0, place: "Japan", tsunami: 1, type: "earthquake" },
      geometry: { type: "Point", coordinates: [142, 38, 30] },
    },
  ],
};

const BOUNDARIES = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { Name: "PA-AU", "len-km": 10 },
      geometry: {
        type: "LineString",
        coordinates: [
          [170, -20],
          [172, -20],
        ],
      },
    },
    {
      type: "Feature",
      properties: { Name: "plate", "len-km": null },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    },
  ],
};

describe("parseGeoJson", () => {
  it("parses points, lines, and numeric properties", () => {
    expect(isGeoJson(EARTHQUAKES)).toBe(true);
    expect(isGeoJson({ type: "Point", coordinates: [0, 0] })).toBe(true);
    expect(isGeoJson({ type: "Topology" })).toBe(false);
    expect(inferVerticalCoordinate(EARTHQUAKES)).toBe("depth_km");
    expect(inferVerticalCoordinate(BOUNDARIES)).toBe("elevation_m");
    expect(sanitizePropertyIdentifier("len-km")).toBe("len_km");
    expect(sanitizePropertyIdentifier("2x__y")).toBe("p_2x_y");

    const quakes = parseGeoJson(EARTHQUAKES, "depth_km");
    expect(quakes.hasVertical).toBe(true);
    expect(quakes.lineStrings).toEqual([]);
    expect(quakes.properties.map((p) => p.identifier)).toEqual([
      "mag",
      "tsunami",
      "depth_km",
    ]);
    expect(quakes.points[0]).toEqual({
      lon: -178,
      lat: -20,
      elevation: -600000,
      properties: [7.1, 0, 600],
      description: "Tonga",
    });
    expect(quakes.bounds).toEqual([-178, -20, 142, 38]);
    expect(quakes.elevationRange).toEqual([-600000, -30000]);

    // Elevations in meters; ignored vertical coordinates.
    expect(parseGeoJson(EARTHQUAKES, "elevation_m").points[1].elevation).toBe(
      30,
    );
    const flat = parseGeoJson(EARTHQUAKES, "none");
    expect(flat.hasVertical).toBe(false);
    expect(flat.elevationRange).toEqual([0, 0]);

    // Polygons are represented by their rings; null values do not exclude numeric properties.
    const boundaries = parseGeoJson(BOUNDARIES, "elevation_m");
    expect(boundaries.points).toEqual([]);
    expect(boundaries.properties.map((p) => p.identifier)).toEqual(["len_km"]);
    expect(boundaries.lineStrings.map((l) => l.positions.length)).toEqual([
      6, 12,
    ]);
    expect(boundaries.lineStrings[0].description).toBe("PA-AU");
    expect(boundaries.lineStrings[1].properties).toEqual([Number.NaN]);
  });

  it("rejects non-GeoJSON values", () => {
    expect(() => parseGeoJson({ type: "Topology" }, "none")).toThrow(
      /Not a GeoJSON object/,
    );
  });

  it("rejects feature collections without a features array", () => {
    expect(() => parseGeoJson({ type: "FeatureCollection" }, "none")).toThrow(
      /features array/,
    );
  });

  it("rejects GeoJSON without point or line geometries", () => {
    expect(() =>
      parseGeoJson({ type: "FeatureCollection", features: [] }, "none"),
    ).toThrow(/no point or line geometries/);
  });
});

describe("parseGeoJsonOptions", () => {
  it("parses options", () => {
    expect(parseGeoJsonOptions(undefined)).toEqual({
      vertical: undefined,
      swath: 1,
      exaggeration: 1,
    });
    expect(
      parseGeoJsonOptions("vertical=depth_km&swath=0.5&exaggeration=10"),
    ).toEqual({ vertical: "depth_km", swath: 0.5, exaggeration: 10 });
  });

  it("rejects invalid vertical coordinates", () => {
    expect(() => parseGeoJsonOptions("vertical=feet")).toThrow(
      /Invalid GeoJSON vertical option/,
    );
  });

  it("rejects non-positive numeric options", () => {
    expect(() => parseGeoJsonOptions("swath=0")).toThrow(
      /Invalid GeoJSON swath option/,
    );
  });

  it("rejects unsupported options", () => {
    expect(() => parseGeoJsonOptions("color=red")).toThrow(
      /Unsupported GeoJSON option/,
    );
  });
});

describe("GeoJSON data source", () => {
  it("represents features as georeferenced annotations", () => {
    const options = parseGeoJsonOptions("swath=2&exaggeration=5");
    const quakes = parseGeoJson(EARTHQUAKES, "depth_km");
    const dataSource = getGeoJsonDataSource(quakes, options);
    const { inputSpace } = dataSource.modelTransform;
    expect(inputSpace.names).toEqual(["x", "y", "z"]);
    expect(inputSpace.units).toEqual(["deg", "deg", ""]);
    expect(inputSpace.scales[0]).toBe(2);
    // Vertical scale in degree-equivalent units, with exaggeration.
    expect(inputSpace.scales[2]).toBeCloseTo(
      (1e5 * 5) / ((Math.PI / 180) * 6378137),
      9,
    );
    expect(dataSource.geoReference).toEqual({
      crs: "EPSG:4326",
      modelDimensions: [0, 1],
      verticalDimensions: [
        { modelDimension: 2, elevations: GEOJSON_VERTICAL_ELEVATIONS },
      ],
    });
    // Level centers correspond to their vertical coordinates.
    GEOJSON_VERTICAL_ELEVATIONS.forEach((elevation, i) =>
      expect(elevationToGeoJsonVerticalCoordinate(elevation)).toBeCloseTo(
        i + 0.5,
        9,
      ),
    );

    // Points: horizontal coordinates in units of the swath, elevation positive up.
    const points = Array.from(
      makeGeoJsonAnnotationSource(quakes, options, undefined),
    ) as Point[];
    expect(points.map((p) => p.type)).toEqual([
      AnnotationType.POINT,
      AnnotationType.POINT,
    ]);
    expect(Array.from(points[0].point)).toEqual([
      -89,
      -10,
      elevationToGeoJsonVerticalCoordinate(-600000),
    ]);
    expect(points[0].properties).toEqual([7.1, 0, 600]);

    // Lines without vertical coordinates lie at sea level.  Lines are densified when reprojected
    // by a non-identity warp, and split where the warp is invalid.
    const boundaries = parseGeoJson(BOUNDARIES, "elevation_m");
    const lines = Array.from(
      makeGeoJsonAnnotationSource(boundaries, options, undefined),
    ) as PolyLine[];
    expect(lines.map((l) => l.points.length)).toEqual([2, 4]);
    expect(lines[0].points[0][2]).toBe(elevationToGeoJsonVerticalCoordinate(0));
    const warp = {
      forward(x: number, y: number, out: Float64Array) {
        out[0] = 2 * x;
        out[1] = y;
        return x > 85.6 && x < 85.9
          ? TransformStatus.INVALID
          : TransformStatus.VALID;
      },
      inverse() {
        return TransformStatus.INVALID;
      },
    };
    const warped = Array.from(
      makeGeoJsonAnnotationSource(boundaries, options, warp),
    ) as PolyLine[];
    // The first line (170E to 172E, swath 2) is densified to 0.5 degree segments.  The point at
    // 171.5E (x = 85.75) is invalid, which leaves a single valid point after it, which is dropped.
    expect(warped.length).toBe(2);
    expect(warped[0].points.map((p) => p[0])).toEqual([170, 170.5, 171]);
    expect(warped[1].points.length).toBe(7);
  });

  it("generates a default shader from the properties", () => {
    const quakes = parseGeoJson(EARTHQUAKES, "depth_km");
    const shader = getGeoJsonDefaultShader(quakes);
    expect(shader).toContain("prop_depth_km()");
    expect(shader).toContain("prop_mag()");
    expect(shader).toContain("default=600");
    const boundaries = parseGeoJson(BOUNDARIES, "elevation_m");
    expect(getGeoJsonDefaultShader(boundaries)).not.toContain("prop_");
  });
});
