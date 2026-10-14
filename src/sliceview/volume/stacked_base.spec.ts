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
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import {
  alignStackedLevels,
  appendChannelDimension,
  getChunkToRenderLayerTransform,
} from "#src/sliceview/volume/stacked_base.js";

/**
 * Returns a 2-d `(rank + 1)^2` transform scaling by `scale` and translating by `offset`.
 */
function scaleTransform(scale: number, offset: number) {
  return Float32Array.of(scale, 0, 0, 0, scale, 0, offset, offset, 1);
}

describe("stacked volume sources", () => {
  it("aligns resolution levels and appends a channel dimension", () => {
    // A 10 m band (levels 10, 20, 40 m) and a 20 m band (levels 20, 40 m) whose model voxels are
    // 10 m and 20 m, respectively, in the same render layer space (with 10 m voxels).
    const band10 = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const band20 = Float32Array.of(2, 0, 0, 0, 2, 0, 0, 0, 1);
    const level = (
      modelToRender: Float32Array,
      chunkToModel: Float32Array,
      size: number,
    ) => ({
      chunkToRenderLayer: getChunkToRenderLayerTransform(
        modelToRender,
        2,
        2,
        chunkToModel,
      ),
      upperVoxelBound: [size, size],
      chunkDataSize: [64, 64],
    });
    const levels10 = [
      level(band10, scaleTransform(1, 0), 1000),
      level(band10, scaleTransform(2, 0), 500),
      level(band10, scaleTransform(4, 0), 250),
    ];
    const levels20 = [
      level(band20, scaleTransform(1, 0), 500),
      level(band20, scaleTransform(2, 0), 250),
    ];
    expect(alignStackedLevels([levels10, levels20], [0, 1])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(alignStackedLevels([levels20, levels10], [0, 1])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    // Levels offset by a voxel, or with different chunking, do not match.
    const offset = [level(band20, scaleTransform(1, 0.5), 500)];
    expect(alignStackedLevels([levels10, offset], [0, 1])).toEqual([]);
    const rechunked = [
      { ...level(band20, scaleTransform(1, 0), 500), chunkDataSize: [32, 32] },
    ];
    expect(alignStackedLevels([levels10, rechunked], [0, 1])).toEqual([]);

    // A channel dimension is inserted after the source dimensions (before synthetic dimensions)
    // and appended to the output dimensions.
    const space = (names: string[]) =>
      makeCoordinateSpace({
        names,
        units: names.map(() => "m"),
        scales: Float64Array.from(names, () => 10),
      });
    const transform = appendChannelDimension(
      {
        rank: 3,
        sourceRank: 2,
        inputSpace: space(["y", "x", "t"]),
        outputSpace: space(["x", "y", "t"]),
        // Swap y and x, translate.
        transform: Float64Array.of(
          0,
          1,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          1,
          0,
          5,
          6,
          7,
          1,
        ),
      },
      "c^",
      4,
    );
    expect(transform.rank).toBe(4);
    expect(transform.sourceRank).toBe(3);
    expect(transform.inputSpace.names).toEqual(["y", "x", "c^", "t"]);
    expect(transform.outputSpace.names).toEqual(["x", "y", "t", "c^"]);
    expect(Array.from(transform.inputSpace.bounds.upperBounds)[2]).toBe(4);
    expect(Array.from(transform.transform)).toEqual([
      0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 5, 6, 7, 0, 1,
    ]);
  });
});
