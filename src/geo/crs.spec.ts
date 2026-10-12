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
import { getCrs, WEB_MERCATOR_MAX_LATITUDE } from "#src/geo/crs.js";
import {
  CrsTransform,
  haversineDistance,
  TransformStatus,
} from "#src/geo/transform.js";

describe("getCrs", () => {
  it("resolves supported specifications", () => {
    const cases: [
      string,
      {
        id: string;
        isGeographic: boolean;
        unit: string;
        worldPeriod: number | undefined;
        centralMeridian: number;
        maxLatitude: number;
      },
    ][] = [
      [
        "EPSG:4326",
        {
          id: "EPSG:4326",
          isGeographic: true,
          unit: "deg",
          worldPeriod: 360,
          centralMeridian: 0,
          maxLatitude: 90,
        },
      ],
      [
        "urn:ogc:def:crs:OGC:1.3:CRS84",
        {
          id: "EPSG:4326",
          isGeographic: true,
          unit: "deg",
          worldPeriod: 360,
          centralMeridian: 0,
          maxLatitude: 90,
        },
      ],
      [
        "epsg:3857",
        {
          id: "EPSG:3857",
          isGeographic: false,
          unit: "m",
          worldPeriod: 2 * Math.PI * 6378137,
          centralMeridian: 0,
          maxLatitude: WEB_MERCATOR_MAX_LATITUDE,
        },
      ],
      [
        "urn:ogc:def:crs:EPSG::32633",
        {
          id: "EPSG:32633",
          isGeographic: false,
          unit: "m",
          worldPeriod: undefined,
          centralMeridian: 15,
          maxLatitude: 90,
        },
      ],
      [
        "EPSG:32760",
        {
          id: "EPSG:32760",
          isGeographic: false,
          unit: "m",
          worldPeriod: undefined,
          centralMeridian: 177,
          maxLatitude: 90,
        },
      ],
      [
        "+proj=eqc +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m",
        {
          id: "+proj=eqc +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m",
          isGeographic: false,
          unit: "m",
          worldPeriod: 2 * Math.PI * 6378137,
          centralMeridian: 0,
          maxLatitude: 90,
        },
      ],
    ];
    for (const [spec, expected] of cases) {
      const crs = getCrs(spec);
      expect({
        id: crs.id,
        isGeographic: crs.isGeographic,
        unit: crs.unit,
        worldPeriod: crs.worldPeriod,
        centralMeridian: crs.centralMeridian,
        maxLatitude: crs.maxLatitude,
      }).toEqual({
        ...expected,
        worldPeriod:
          expected.worldPeriod === undefined
            ? undefined
            : expect.closeTo(expected.worldPeriod, 3),
        centralMeridian: expect.closeTo(expected.centralMeridian, 9),
      });
    }
  });

  it("rejects unknown EPSG codes", () => {
    expect(() => getCrs("EPSG:999999")).toThrow(/Unsupported CRS EPSG:999999/);
  });

  it("rejects unrecognized specifications", () => {
    expect(() => getCrs("not a crs")).toThrow(/Unsupported CRS specification/);
  });
});

describe("CrsTransform", () => {
  it("round-trips points between CRSs", () => {
    const cases: [string, string, number, number][] = [
      // UTM 33N (Berlin) <-> geographic
      ["EPSG:32633", "EPSG:4326", 391000, 5820000],
      // UTM 33N <-> Web Mercator
      ["EPSG:32633", "EPSG:3857", 391000, 5820000],
      // Geographic <-> polar stereographic
      ["EPSG:4326", "EPSG:3413", -40, 72],
      // Web Mercator <-> LAEA Europe
      ["EPSG:3857", "EPSG:3035", 1500000, 6800000],
      // Identity
      ["EPSG:4326", "EPSG:4326", 12.5, -33],
    ];
    const out = new Float64Array(2);
    const back = new Float64Array(2);
    for (const [source, target, x, y] of cases) {
      const t = new CrsTransform(getCrs(source), getCrs(target));
      expect(t.forward(x, y, out)).toBe(TransformStatus.VALID);
      expect(t.inverse(out[0], out[1], back)).toBe(TransformStatus.VALID);
      expect(back[0]).toBeCloseTo(x, 2);
      expect(back[1]).toBeCloseTo(y, 2);
    }
  });

  it("projects known reference points", () => {
    const out = new Float64Array(2);
    new CrsTransform(getCrs("EPSG:4326"), getCrs("EPSG:32633")).forward(
      15,
      52,
      out,
    );
    expect(out[0]).toBeCloseTo(500000, 3);
    expect(out[1]).toBeCloseTo(5761038.2126, 3);
    new CrsTransform(getCrs("EPSG:4326"), getCrs("EPSG:3857")).forward(
      -180,
      0,
      out,
    );
    expect(out[0]).toBeCloseTo(-20037508.3428, 3);
  });

  it("clamps latitudes beyond the Web Mercator limit", () => {
    const out = new Float64Array(2);
    const t = new CrsTransform(getCrs("EPSG:4326"), getCrs("EPSG:3857"));
    expect(t.forward(0, 89, out)).toBe(TransformStatus.CLAMPED);
    expect(out[1]).toBeCloseTo(20037508.3428, 3);
  });

  it("clamps latitudes slightly beyond the poles", () => {
    const t = new CrsTransform(getCrs("EPSG:4326"), getCrs("EPSG:4326"));
    const out = new Float64Array(2);
    // Identity transforms do not check the domain.
    expect(t.forward(0, 90.125, out)).toBe(TransformStatus.VALID);
    const m = new CrsTransform(getCrs("EPSG:4326"), getCrs("EPSG:3857"));
    expect(m.forward(0, 90.125, out)).toBe(TransformStatus.CLAMPED);
    expect(m.forward(0, 96, out)).toBe(TransformStatus.INVALID);
  });

  it("unwraps longitudes across the antimeridian", () => {
    // UTM zone 1 is centered at -177 degrees; points west of the zone boundary should map to
    // longitudes < -180 rather than wrapping to +180.
    const t = new CrsTransform(
      getCrs("EPSG:32601"),
      getCrs("EPSG:4326"),
      /*referenceLongitude=*/ -177,
    );
    const out = new Float64Array(2);
    expect(t.forward(100000, 1000000, out)).toBe(TransformStatus.VALID);
    expect(out[0]).toBeLessThan(-180);
    expect(out[0]).toBeGreaterThan(-185);
  });

  it("reports points that cannot be transformed", () => {
    const out = new Float64Array(2);
    const t = new CrsTransform(getCrs("EPSG:3413"), getCrs("EPSG:4326"));
    expect(t.inverse(0, 100, out)).toBe(TransformStatus.INVALID);
  });
});

describe("haversineDistance", () => {
  it("computes great-circle distances", () => {
    // One degree of latitude.
    expect(haversineDistance(0, 0, 0, 1)).toBeCloseTo(111195, -1);
    // Quarter of the equator.
    expect(haversineDistance(0, 0, 90, 0)).toBeCloseTo(
      (Math.PI / 2) * 6371008.8,
      3,
    );
  });
});
