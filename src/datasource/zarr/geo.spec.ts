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
import type { XarrayArrayInfo } from "#src/datasource/zarr/geo.js";
import {
  getElevations,
  getGeoZarrGeoreference,
  getRegularAxis,
  getXarrayDefaultShader,
  isGeographicCoordinate,
  parseGeoZarrMultiscales,
  pressureToAltitude,
  selectXarrayVariable,
  unpackCfValues,
} from "#src/datasource/zarr/geo.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { DataType } from "#src/util/data_type.js";

function makeMetadata(
  attrs: Record<string, unknown>,
  fillValue: number = Number.NaN,
  dataType: DataType = DataType.FLOAT32,
): ArrayMetadata {
  return {
    dataType,
    fillValue,
    userAttributes: attrs,
  } as unknown as ArrayMetadata;
}

function makeArrays(
  entries: [string, string[], number[], Record<string, unknown>?][],
): Map<string, XarrayArrayInfo> {
  return new Map(
    entries.map(([name, dims, shape, attrs = {}]) => [
      name,
      { dims, shape, chunks: shape, dtype: '"<f4"', attrs },
    ]),
  );
}

describe("xarray georeferencing", () => {
  it("detects regularly-spaced axes", () => {
    const cases: [number[], { start: number; step: number } | undefined][] = [
      [[-180, -179.5, -179, -178.5], { start: -180, step: 0.5 }],
      [[90, 89, 88], { start: 90, step: -1 }],
      // float32 rounding of a 1/12 degree grid.
      [
        Array.from({ length: 100 }, (_, i) => Math.fround(-80 + i / 12)),
        { start: -80, step: expect.closeTo(1 / 12, 6) as unknown as number },
      ],
      [[0, 1, 3], undefined],
      [[5], undefined],
    ];
    for (const [values, expected] of cases) {
      const result = getRegularAxis(values);
      if (expected === undefined) {
        expect(result, JSON.stringify(values)).toBe(undefined);
      } else {
        expect(result, JSON.stringify(values)).toEqual(expected);
      }
    }
  });

  it("uses CF bounds for the spacing of a single coordinate", () => {
    expect(getRegularAxis([45], [44.5, 45.5])).toEqual({ start: 45, step: 1 });
    expect(getRegularAxis([45], [45.5, 44.5])).toEqual({
      start: 45,
      step: -1,
    });
    expect(getRegularAxis([45], [45, 45])).toBe(undefined);
  });

  it("detects geographic coordinates", () => {
    const cases: [
      "longitude" | "latitude",
      number[],
      Record<string, unknown>,
    ][] = [
      ["longitude", [-180, 0, 179.5], {}],
      ["longitude", [0, 180, 359.75], { units: "degrees_east" }],
      ["longitude", [0, 1], { units: "degree_E", standard_name: "longitude" }],
      ["longitude", [0, 1], { units: "degreesE" }],
      ["longitude", [0, 1], { units: "degrees" }],
      ["latitude", [-90, 0, 90], { units: "degrees_north" }],
      ["latitude", [90.00001, 0], { units: "degree_N" }],
      ["latitude", [10, 20], { standard_name: "latitude" }],
    ];
    for (const [kind, values, attrs] of cases) {
      expect(
        isGeographicCoordinate(kind, values, attrs),
        JSON.stringify([kind, values, attrs]),
      ).toBe(true);
    }
  });

  it("rejects geographic coordinates with non-degree units", () => {
    expect(isGeographicCoordinate("longitude", [0, 1000], { units: "m" })).toBe(
      false,
    );
    expect(
      isGeographicCoordinate("longitude", [0, 1], { units: "degrees_north" }),
    ).toBe(false);
  });

  it("rejects geographic coordinates with another standard name", () => {
    expect(
      isGeographicCoordinate("longitude", [0, 1], {
        standard_name: "grid_longitude",
      }),
    ).toBe(false);
  });

  it("rejects geographic coordinates out of range", () => {
    expect(isGeographicCoordinate("longitude", [0, 500, 1000])).toBe(false);
    expect(isGeographicCoordinate("latitude", [-100, 0, 100])).toBe(false);
  });

  it("converts vertical coordinates to elevations", () => {
    const cases: [string, number[], Record<string, unknown>, number[]][] = [
      ["depth", [0.5, 10, 100], {}, [-0.5, -10, -100]],
      ["elevation", [-100, -10, -0.5], {}, [-100, -10, -0.5]],
      // Depth coordinates stored as negative values are already elevations.
      ["depth", [-0.5, -10], {}, [-0.5, -10]],
      ["depth", [-0.5, -10], { units: "m", positive: "up" }, [-0.5, -10]],
      ["z", [5, 15], { units: "m" }, [5, 15]],
      ["z", [5, 15], { units: "m", positive: "down" }, [-5, -15]],
      ["height", [1, 2], { units: "km", axis: "Z" }, [1000, 2000]],
      // CESM ocean levels in centimeters.
      [
        "lev",
        [500, 1500],
        { units: "centimeters", positive: "down" },
        [-5, -15],
      ],
      // ERA5 pressure levels.
      [
        "level",
        [1000, 500],
        { units: "millibars" },
        [pressureToAltitude(100000), pressureToAltitude(50000)],
      ],
      [
        "plev",
        [101325, 50000],
        { units: "Pa" },
        [0, pressureToAltitude(50000)],
      ],
    ];
    for (const [name, values, attrs, expected] of cases) {
      const result = getElevations(name, values, attrs);
      expect(result, JSON.stringify([name, values, attrs])).toBeDefined();
      for (let i = 0; i < expected.length; ++i) {
        expect(result![i]).toBeCloseTo(expected[i], 6);
      }
    }
    // Standard atmosphere: 500 hPa is at approximately 5.6 km.
    expect(pressureToAltitude(50000)).toBeCloseTo(5574, -1);
  });

  it("rejects dimensionless vertical coordinates", () => {
    expect(getElevations("lev", [0.1, 0.5, 0.9], { units: "1" })).toBe(
      undefined,
    );
    expect(getElevations("lev", [0.1, 0.5, 0.9], {})).toBe(undefined);
    expect(
      getElevations("lev", [0.1, 0.5], {
        standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
      }),
    ).toBe(undefined);
    expect(
      getElevations("lev", [0.1, 0.5], { formula_terms: "sigma: lev" }),
    ).toBe(undefined);
  });

  it("rejects vertical coordinates with unknown units", () => {
    expect(getElevations("level", [1, 2], { units: "K" })).toBe(undefined);
  });

  it("rejects non-vertical axes", () => {
    expect(getElevations("z", [1, 2], { units: "m", axis: "X" })).toBe(
      undefined,
    );
  });

  it("rejects negative pressures", () => {
    expect(getElevations("plev", [-1, 2], { units: "Pa" })).toBe(undefined);
  });

  it("unpacks coordinate values", () => {
    expect(unpackCfValues([1, 2], {})).toEqual([1, 2]);
    expect(
      unpackCfValues([0, 10], { scale_factor: 0.5, add_offset: -90 }),
    ).toEqual([-90, -85]);
    expect(unpackCfValues([0, 10], { scale_factor: [2] })).toEqual([0, 20]);
  });

  it("selects data variables", () => {
    const arrays = makeArrays([
      ["time", ["time"], [3]],
      ["latitude", ["latitude"], [10]],
      ["longitude", ["longitude"], [20]],
      ["vo", ["time", "latitude", "longitude"], [3, 10, 20]],
      ["uo", ["time", "latitude", "longitude"], [3, 10, 20]],
      ["mask", ["latitude", "longitude"], [10, 20]],
    ]);
    // Default: the highest-rank variable (the first by name among equals).
    expect(selectXarrayVariable(arrays, undefined)).toBe("uo");
    expect(selectXarrayVariable(arrays, "vo")).toBe("vo");
    // CMIP6-style dataset with CF bounds arrays.
    const cmip = makeArrays([
      ["lat", ["lat"], [10], { bounds: "lat_bnds" }],
      ["lon", ["lon"], [20], { bounds: "lon_bnds" }],
      ["time", ["time"], [3], { bounds: "time_bnds" }],
      ["lat_bnds", ["lat", "bnds"], [10, 2]],
      ["lon_bnds", ["lon", "bnds"], [20, 2]],
      ["time_bnds", ["time", "bnds"], [3, 2]],
      // Bounds-like dimension without a `bounds` attribute referencing it.
      ["vertices", ["lat", "lon", "nv"], [10, 20, 4]],
      ["areacello", ["y", "x"], [10, 20]],
      ["sst", ["time", "lat", "lon"], [3, 10, 20]],
    ]);
    expect(selectXarrayVariable(cmip, undefined)).toBe("sst");
    // Variables with longitude and latitude dimensions are preferred.
    const mixed = makeArrays([
      ["a", ["t", "y", "x"], [3, 10, 20]],
      ["b", ["lat", "lon"], [10, 20]],
    ]);
    expect(selectXarrayVariable(mixed, undefined)).toBe("b");
  });

  it("rejects missing variables", () => {
    const arrays = makeArrays([["uo", ["y", "x"], [2, 2]]]);
    expect(() => selectXarrayVariable(arrays, "vo")).toThrow(
      /Variable "vo" not found/,
    );
  });

  it("rejects datasets without data variables", () => {
    const arrays = makeArrays([["latitude", ["latitude"], [10]]]);
    expect(() => selectXarrayVariable(arrays, undefined)).toThrow(
      /no data variables/,
    );
  });

  it("generates default shaders", () => {
    const temperature = makeMetadata(
      { valid_min: -10, valid_max: 40, units: "degrees_C" },
      9.969209968386869e36,
    );
    const shader = getXarrayDefaultShader(temperature)!;
    expect(shader).toContain("range=[-10, 40]");
    expect(shader).toContain("9.969209968386869e+36");
    expect(shader).toContain("getDataValue()");
    // Packed integer variables.
    const packed = makeMetadata(
      {
        scale_factor: 0.01,
        add_offset: 273,
        _FillValue: -32767,
        valid_range: [-30000, 30000],
      },
      0,
      DataType.INT16,
    );
    expect(getXarrayDefaultShader(packed))
      .toBe(`#uicontrol invlerp normalized(range=[-30000, 30000])
void main() {
  float raw = float(toRaw(getDataValue()));
  if (raw == -32767.0) {
    emitTransparent();
    return;
  }
  // Unpacked value (the colormap range applies to the packed value).
  float value = raw * 0.01 + 273.0;
  emitRGB(colormapJet(normalized()));
}
`);
    // A negative scale factor reverses the range.
    expect(
      getXarrayDefaultShader(
        makeMetadata(
          { scale_factor: -1, valid_min: 0, valid_max: 100 },
          0,
          DataType.UINT8,
        ),
      ),
    ).toContain("range=[100, 0]");
    // Unpacked integer variables without a fill value.
    expect(getXarrayDefaultShader(makeMetadata({}, 0, DataType.UINT16)))
      .toBe(`#uicontrol invlerp normalized
void main() {
  float value = float(toRaw(getDataValue()));
  emitRGB(colormapJet(normalized()));
}
`);
    expect(getXarrayDefaultShader(makeMetadata({}, 0, DataType.UINT64))).toBe(
      undefined,
    );
  });
});

describe("GeoZarr conventions", () => {
  it("determines the georeference and resolution levels", () => {
    // Attributes of an EOPF Sentinel-2 product (UTM zone 32N, 10 m pixels).
    const attrs = {
      "proj:code": "EPSG:32632",
      "spatial:dimensions": ["y", "x"],
      "spatial:transform": [10, 0, 699960, 0, -10, 5000040],
    };
    expect(getGeoZarrGeoreference(attrs, ["y", "x"])).toEqual({
      crs: "EPSG:32632",
      lonDim: 1,
      latDim: 0,
      lon: { start: 699965, step: 10 },
      lat: { start: 5000035, step: -10 },
      verticalScales: new Map(),
      verticalElevations: new Map(),
    });
    // Dimension order follows the array; "node" registration maps pixel centers.
    const node = getGeoZarrGeoreference(
      { ...attrs, "spatial:registration": "node" },
      ["band", "x", "y"],
    )!;
    expect([node.lonDim, node.latDim]).toEqual([1, 2]);
    expect(node.lon.start).toBe(699960);
    expect(
      parseGeoZarrMultiscales({
        multiscales: {
          layout: [
            { asset: "r10m", "spatial:transform": [10, 0, 0, 0, -10, 0] },
            { asset: "r20m", derived_from: "r10m" },
          ],
        },
      }),
    ).toEqual([
      { asset: "r10m", attrs: { "spatial:transform": [10, 0, 0, 0, -10, 0] } },
      { asset: "r20m", attrs: { derived_from: "r10m" } },
    ]);
  });

  it("ignores missing or unsupported georeferencing", () => {
    const attrs = {
      "proj:code": "EPSG:32632",
      "spatial:transform": [10, 0, 699960, 0, -10, 5000040],
    };
    expect(getGeoZarrGeoreference({}, ["y", "x"])).toBe(undefined);
    // Rotated transforms.
    expect(
      getGeoZarrGeoreference(
        { ...attrs, "spatial:transform": [10, 1, 0, 0, -10, 0] },
        ["y", "x"],
      ),
    ).toBe(undefined);
    // Spatial dimensions not among the array dimensions.
    expect(getGeoZarrGeoreference(attrs, ["lat", "lon"])).toBe(undefined);
    expect(parseGeoZarrMultiscales({ multiscales: { layout: [] } })).toBe(
      undefined,
    );
    expect(parseGeoZarrMultiscales({ multiscales: [{ datasets: [] }] })).toBe(
      undefined,
    );
  });
});
