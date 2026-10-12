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
  getRegularAxis,
  getXarrayDatasetDefaultShader,
  getXarrayDefaultShader,
  isVectorPair,
  selectXarrayVariables,
} from "#src/datasource/zarr/geo.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { DataType } from "#src/util/data_type.js";

function makeMetadata(
  attrs: Record<string, unknown>,
  fillValue: number = Number.NaN,
): ArrayMetadata {
  return {
    dataType: DataType.FLOAT32,
    fillValue,
    userAttributes: attrs,
  } as unknown as ArrayMetadata;
}

function makeArrays(
  entries: [string, string[], number[]][],
): Map<string, XarrayArrayInfo> {
  return new Map(
    entries.map(([name, dims, shape]) => [
      name,
      { dims, shape, chunks: shape, dtype: '"<f4"', attrs: {} },
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

  it("converts vertical coordinates to elevations", () => {
    expect(getElevations("depth", [0.5, 10, 100])).toEqual([-0.5, -10, -100]);
    expect(getElevations("elevation", [-100, -10, -0.5])).toEqual([
      -100, -10, -0.5,
    ]);
    // Depth coordinates stored as negative values are already elevations.
    expect(getElevations("depth", [-0.5, -10])).toEqual([-0.5, -10]);
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
    // Default: variables matching the first data variable in sorted order ("mask").
    expect(selectXarrayVariables(arrays, undefined)).toEqual(["mask"]);
    expect(selectXarrayVariables(arrays, ["uo", "vo"])).toEqual(["uo", "vo"]);
    const currents = makeArrays([
      ["latitude", ["latitude"], [10]],
      ["uo", ["latitude", "longitude"], [10, 20]],
      ["vo", ["latitude", "longitude"], [10, 20]],
    ]);
    expect(selectXarrayVariables(currents, undefined)).toEqual(["uo", "vo"]);
  });

  it("rejects missing variables", () => {
    const arrays = makeArrays([["uo", ["y", "x"], [2, 2]]]);
    expect(() => selectXarrayVariables(arrays, ["vo"])).toThrow(
      /Variable "vo" not found/,
    );
  });

  it("rejects variables with differing shapes", () => {
    const arrays = makeArrays([
      ["uo", ["y", "x"], [2, 2]],
      ["sst", ["y", "x"], [2, 3]],
    ]);
    expect(() => selectXarrayVariables(arrays, ["uo", "sst"])).toThrow(
      /must have the same dimensions/,
    );
  });

  it("rejects datasets without data variables", () => {
    const arrays = makeArrays([["latitude", ["latitude"], [10]]]);
    expect(() => selectXarrayVariables(arrays, undefined)).toThrow(
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
    const u = makeMetadata({ standard_name: "eastward_sea_water_velocity" });
    const v = makeMetadata({ standard_name: "northward_sea_water_velocity" });
    expect(isVectorPair([u, v])).toBe(true);
    expect(isVectorPair([v, u])).toBe(false);
    expect(getXarrayDatasetDefaultShader([u, v])).toContain(
      "length(vec2(u, v))",
    );
    // Other multi-variable datasets show the first variable.
    expect(getXarrayDatasetDefaultShader([temperature, temperature])).toContain(
      "getDataValue(0)",
    );
  });
});
