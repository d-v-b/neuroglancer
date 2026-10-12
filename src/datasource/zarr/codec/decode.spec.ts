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
import { getShardedChunkKey } from "#src/datasource/zarr/codec/decode.js";
import type { CodecChainSpec } from "#src/datasource/zarr/codec/index.js";

describe("getShardedChunkKey", () => {
  it("computes sub-chunk keys", () => {
    // 2-d array with shards of 2x3 sub-chunks; sub-chunks of shape [4, 5] are read as chunks.
    const layoutInfo = [
      { physicalToLogicalDimension: [0, 1], readChunkShape: [4, 5] },
    ];
    const subChunkCodecs = { layoutInfo } as unknown as CodecChainSpec;
    const codecs = {
      layoutInfo,
      shardingInfo: {
        subChunkShape: [4, 5],
        subChunkGridShape: [2, 3],
        subChunkCodecs,
      },
    } as unknown as CodecChainSpec;
    const cases: [number[], number[]][] = [
      // Chunk grid positions are in Fortran order: [dim 1, dim 0].
      [
        [0, 0],
        [0, 0],
      ],
      [
        [4, 3],
        [1, 1],
      ],
      [
        [2, 1],
        [1, 2],
      ],
      // An additional trailing (variable) dimension is ignored.
      [
        [4, 3, 1],
        [1, 1],
      ],
    ];
    for (const [position, subChunk] of cases) {
      expect(getShardedChunkKey(codecs, position, "c/0/1")).toEqual({
        base: "c/0/1",
        subChunk,
      });
    }
    expect(getShardedChunkKey(subChunkCodecs, [4, 3, 1], "c/1/2")).toBe(
      "c/1/2",
    );
  });
});
