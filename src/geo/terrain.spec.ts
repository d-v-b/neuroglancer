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
  chooseTerrainZoom,
  decodeTerrarium,
  lonLatToTileCoordinates,
  TerrainSource,
} from "#src/geo/terrain.js";

describe("terrain", () => {
  it("decodes, locates, and samples terrain tiles", async () => {
    // 0 m, 8848 m, and -10994 m.
    expect(
      Array.from(
        decodeTerrarium([128, 0, 0, 255, 162, 144, 0, 255, 85, 14, 0, 255]),
      ),
    ).toEqual([0, 8848, -10994]);
    expect(lonLatToTileCoordinates(0, 0, 1)).toEqual([1, 1]);
    const [tx, ty] = lonLatToTileCoordinates(-180, 85.0511287798066, 3);
    expect(tx).toBe(0);
    expect(ty).toBeCloseTo(0, 6);
    // Zoom 0 has about 156 km per pixel at the equator.
    expect(chooseTerrainZoom(156000, 0)).toBe(0);
    expect(chooseTerrainZoom(38, 0)).toBe(12);
    expect(chooseTerrainZoom(1, 0)).toBe(12);

    // Tiles at zoom z have the constant elevation 100 * z, except that zoom 2 fails to load.
    const requested: string[] = [];
    const source = new TerrainSource("{z}/{x}/{y}", async (url) => {
      requested.push(url);
      const z = Number(url.split("/")[0]);
      if (z === 2) throw new Error("missing");
      return new Int16Array(256 * 256).fill(100 * z);
    });
    const status = { exact: true };
    expect(source.sample(10, 10, 1, status)).toBe(undefined);
    expect(status.exact).toBe(false);
    expect(requested).toEqual(["1/1/0"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    status.exact = true;
    expect(source.sample(10, 10, 1, status)).toBe(100);
    expect(status.exact).toBe(true);
    // Finer tiles that are not yet loaded fall back to loaded coarser tiles.
    status.exact = true;
    expect(source.sample(10, 10, 3, status)).toBe(100);
    expect(status.exact).toBe(false);
    // Tiles that fail to load are not waited for.
    source.sample(10, 10, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    status.exact = true;
    expect(source.sample(10, 10, 2, status)).toBe(100);
    expect(status.exact).toBe(true);
  });
});
