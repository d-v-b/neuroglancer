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
import type {
  GeoLevelInput,
  GeoLevelPlanInput,
} from "#src/sliceview/geo_levels.js";
import {
  computeGeoLevelPlan,
  geoLevelChunkFromKey,
  geoLevelChunkKey,
} from "#src/sliceview/geo_levels.js";

const CHUNK_SIZE = 256;

/**
 * Levels of a pyramid with a finest level of `size` voxels, each downsampled by 2.
 */
function makeLevels(size: number, numLevels: number): GeoLevelInput[] {
  const levels: GeoLevelInput[] = [];
  for (let i = 0; i < numLevels; ++i) {
    const f = 2 ** i;
    const levelSize = Math.ceil(size / f);
    levels.push({
      fromLevel0: [1 / f, 0, 0, 1 / f, 0, 0],
      chunkSizeX: CHUNK_SIZE,
      chunkSizeY: CHUNK_SIZE,
      lowerChunkX: 0,
      lowerChunkY: 0,
      upperChunkX: Math.ceil(levelSize / CHUNK_SIZE),
      upperChunkY: Math.ceil(levelSize / CHUNK_SIZE),
    });
  }
  return levels;
}

function getChunks(
  plan: ReturnType<typeof computeGeoLevelPlan>,
  levels: GeoLevelInput[],
  level: number,
) {
  return Array.from(plan.chunks[level].keys())
    .map((key) => geoLevelChunkFromKey(levels[level], key).join(","))
    .sort();
}

describe("computeGeoLevelPlan", () => {
  it("chooses levels per region and bounds the number of tiles", () => {
    const size = 1 << 16;
    const levels = makeLevels(size, 9);
    const base: Omit<GeoLevelPlanInput, "screenToSource"> = {
      levels,
      width: 512,
      height: 512,
      renderScaleTarget: 1,
    };

    // Chunk keys round trip.
    expect(
      geoLevelChunkFromKey(levels[2], geoLevelChunkKey(levels[2], 5, 7)),
    ).toEqual([5, 7]);

    // Uniform mapping with 4 finest-level voxels per pixel: level 2 is chosen everywhere, and the
    // coarser levels are included as fallback.
    {
      const plan = computeGeoLevelPlan({
        ...base,
        screenToSource: (px, py, out) => {
          out[0] = 10000 + 4 * px;
          out[1] = 20000 + 4 * py;
          return 0;
        },
      });
      expect(new Set(plan.cellLevels)).toEqual(new Set([2]));
      expect(plan.chunks[0].size).toBe(0);
      expect(plan.chunks[1].size).toBe(0);
      // 2048 level-0 voxels = 512 level-2 voxels = 2 chunks, plus padding at the edges.
      expect(getChunks(plan, levels, 2).length).toBeGreaterThanOrEqual(4);
      expect(getChunks(plan, levels, 2).length).toBeLessThanOrEqual(16);
      expect(plan.chunks[8].size).toBe(1);
      // The render scale target selects coarser levels.
      const coarser = computeGeoLevelPlan({
        ...base,
        renderScaleTarget: 2,
        screenToSource: (px, py, out) => {
          out[0] = 10000 + 4 * px;
          out[1] = 20000 + 4 * py;
          return 0;
        },
      });
      expect(new Set(coarser.cellLevels)).toEqual(new Set([3]));
    }

    // Strongly anisotropic mapping, as near a pole: within the leftmost 64 pixels of the view, the
    // source position sweeps across the entire width of the source, while elsewhere the mapping is
    // uniform with 4 finest-level voxels per pixel.  Cells overlapping the sweep would require an
    // excessive number of tiles at level 2, so coarser levels are chosen for them.
    {
      const maxTilesPerCell = 8;
      const maxTilesPerView = 48;
      const plan = computeGeoLevelPlan({
        ...base,
        maxTilesPerCell,
        maxTilesPerView,
        screenToSource: (px, py, out) => {
          out[0] = px < 64 ? (px / 64) * (size - 1) : 4 * px;
          out[1] = 4 * py;
          return 0;
        },
      });
      // Cells are ordered row-major with 4 cells per row; the first column overlaps the sweep.
      for (let i = 0; i < plan.cellLevels.length; ++i) {
        if (i % 4 === 0) {
          expect(plan.cellLevels[i]).toBeGreaterThan(2);
        } else {
          expect(plan.cellLevels[i]).toBeLessThanOrEqual(3);
        }
      }
      // The per-view limit applies to the chunks of the chosen levels.
      const chosen = new Set(plan.cellLevels);
      const finest = Math.min(...chosen);
      expect(plan.chunks[finest].size).toBeLessThanOrEqual(maxTilesPerView);
    }

    // World copies: a source of one world period shown twice side by side.  Cells containing the
    // boundary between copies have separate footprints in each copy rather than one spanning the
    // entire source.
    {
      const period = 1024;
      const plan = computeGeoLevelPlan({
        ...base,
        screenToSource: (px, py, out) => {
          const copy = Math.floor(px / 256);
          out[0] = (px - copy * 256) * (period / 256) + 4096;
          out[1] = 4096 + 4 * py;
          return copy;
        },
      });
      expect(new Set(plan.cellLevels)).toEqual(new Set([2]));
      // Each copy covers level-2 x range [1024, 1280) i.e. chunks 4..5 (with padding), not the
      // entire range between them.
      const xs = new Set(
        getChunks(plan, levels, 2).map((c) => +c.split(",")[0]),
      );
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(3);
      expect(Math.max(...xs)).toBeLessThanOrEqual(5);
    }

    // Partially covered view: only cells overlapping the source have footprints.
    {
      const plan = computeGeoLevelPlan({
        ...base,
        screenToSource: (px, py, out) => {
          if (px > 128 || py > 128) return undefined;
          out[0] = 4 * px;
          out[1] = 4 * py;
          return 0;
        },
      });
      expect(plan.cellLevels.length).toBeLessThanOrEqual(4);
      expect(getChunks(plan, levels, 2)).toEqual(["0,0"]);
    }
  });

  it("returns no chunks if the view does not overlap the source", () => {
    const levels = makeLevels(4096, 3);
    const plan = computeGeoLevelPlan({
      levels,
      width: 256,
      height: 256,
      renderScaleTarget: 1,
      screenToSource: () => undefined,
    });
    expect(plan.chunks.map((m) => m.size)).toEqual([0, 0, 0]);
    expect(plan.cellLevels).toEqual([]);
  });

  it("returns no chunks for an empty viewport", () => {
    const levels = makeLevels(4096, 3);
    const plan = computeGeoLevelPlan({
      levels,
      width: 0,
      height: 256,
      renderScaleTarget: 1,
      screenToSource: (px, py, out) => {
        out[0] = px;
        out[1] = py;
        return 0;
      },
    });
    expect(plan.chunks.map((m) => m.size)).toEqual([0, 0, 0]);
  });
});
