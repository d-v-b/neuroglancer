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
 * @file The zarr-extensions `rectilinear` chunk grid
 * (https://github.com/zarr-developers/zarr-extensions/tree/main/chunk-grids/rectilinear),
 * whose chunk lengths vary along each dimension.
 *
 * Neuroglancer's chunks lie on a regular grid, so a rectilinear array is
 * read through a regular grid whose chunk length along each dimension is the
 * largest zarr chunk length along it. Each Neuroglancer chunk is assembled
 * from the zarr chunks it overlaps, found from their cumulative lengths.
 * When the zarr chunks are regular but for a shorter last one (as for
 * clipped image pyramid levels), each Neuroglancer chunk is exactly one zarr
 * chunk, which is decoded in place.
 */

import type { TypedArray } from "#src/util/array.js";
import { verifyConstant, verifyObjectProperty } from "#src/util/json.js";

/** A run of `count` chunks of `length` elements along one dimension. */
export type ChunkLengthRun = [length: number, count: number];

export interface RectilinearChunkGrid {
  /**
   * For each array dimension, the chunk lengths as runs, covering the
   * dimension's extent exactly or overflowing it within the last chunk
   * (chunks wholly beyond it are dropped).
   */
  runs: ChunkLengthRun[][];
  /**
   * The array's `codecs` JSON, resolved again for each distinct chunk shape
   * (see `getCodecsForChunkShape`).
   */
  codecs: unknown;
}

function parsePositiveInteger(x: unknown): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) {
    throw new Error(
      `Expected positive integer, but received: ${JSON.stringify(x)}`,
    );
  }
  return x;
}

/**
 * Parses one element of `chunk_shapes`: an integer (a regular step), or a
 * list of integers and `[length, count]` runs. Returns runs covering
 * `extent`, dropping chunks wholly beyond it.
 */
export function parseChunkLengths(
  obj: unknown,
  extent: number,
): ChunkLengthRun[] {
  let runs: ChunkLengthRun[];
  if (typeof obj === "number") {
    const length = parsePositiveInteger(obj);
    runs = [[length, Math.max(1, Math.ceil(extent / length))]];
  } else if (Array.isArray(obj)) {
    runs = obj.map((element): ChunkLengthRun => {
      if (Array.isArray(element)) {
        if (element.length !== 2) {
          throw new Error(
            `Expected [length, count], but received: ${JSON.stringify(element)}`,
          );
        }
        return [
          parsePositiveInteger(element[0]),
          parsePositiveInteger(element[1]),
        ];
      }
      return [parsePositiveInteger(element), 1];
    });
  } else {
    throw new Error(
      `Expected integer or array, but received: ${JSON.stringify(obj)}`,
    );
  }
  // Keep the chunks that start before `extent` (at least one).
  const kept: ChunkLengthRun[] = [];
  let start = 0;
  for (const [length, count] of runs) {
    if (start >= extent && kept.length > 0) break;
    const needed = Math.max(1, Math.ceil((extent - start) / length));
    const n = Math.min(count, needed);
    const last = kept[kept.length - 1];
    if (last !== undefined && last[0] === length) {
      last[1] += n;
    } else {
      kept.push([length, n]);
    }
    start += length * n;
  }
  if (start < extent) {
    throw new Error(
      `Chunk lengths sum to ${start}, less than the extent ${extent}`,
    );
  }
  return kept;
}

/**
 * Parses the configuration of a `rectilinear` chunk grid for an array of
 * shape `shape`.
 */
export function parseRectilinearChunkGrid(
  configuration: unknown,
  shape: readonly number[],
  codecs: unknown,
): RectilinearChunkGrid {
  verifyObjectProperty(configuration, "kind", (kind) =>
    verifyConstant(kind, "inline"),
  );
  const runs = verifyObjectProperty(configuration, "chunk_shapes", (value) => {
    if (!Array.isArray(value) || value.length !== shape.length) {
      throw new Error(
        `Expected array of length ${shape.length}, but received: ${JSON.stringify(value)}`,
      );
    }
    return value.map((lengths, i) => {
      try {
        return parseChunkLengths(lengths, shape[i]);
      } catch (e) {
        throw new Error(`Dimension ${i}: ${e.message}`);
      }
    });
  });
  return { runs, codecs };
}

/** The largest chunk length along each dimension. */
export function getMaxChunkShape(grid: RectilinearChunkGrid): number[] {
  return grid.runs.map((runs) => Math.max(...runs.map(([length]) => length)));
}

/** A chunk along one dimension: its index, start position and length. */
export interface ChunkExtent {
  index: number;
  start: number;
  length: number;
}

/** The chunks along one dimension of a rectilinear grid. */
export class RectilinearDimension {
  // For each run, the position and chunk index at which it starts.
  private runStart: Float64Array;
  private runIndex: Float64Array;
  private runLength: Float64Array;

  constructor(runs: readonly ChunkLengthRun[]) {
    const n = runs.length;
    this.runStart = new Float64Array(n);
    this.runIndex = new Float64Array(n);
    this.runLength = new Float64Array(n);
    let start = 0;
    let index = 0;
    for (let i = 0; i < n; ++i) {
      const [length, count] = runs[i];
      this.runStart[i] = start;
      this.runIndex[i] = index;
      this.runLength[i] = length;
      start += length * count;
      index += count;
    }
  }

  /**
   * Returns the index, start and length of the chunk holding `position`
   * (the last chunk for a position beyond it).
   */
  findChunk(position: number): ChunkExtent {
    const { runStart, runIndex, runLength } = this;
    let lo = 0;
    let hi = runStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runStart[mid] <= position) lo = mid;
      else hi = mid - 1;
    }
    const length = runLength[lo];
    const k = Math.floor((position - runStart[lo]) / length);
    return {
      index: runIndex[lo] + k,
      start: runStart[lo] + k * length,
      length,
    };
  }
}

/** Returns the chunks of \`dimension\` that overlap \`[lower, upper)\`. */
export function getCoveringChunks(
  dimension: RectilinearDimension,
  lower: number,
  upper: number,
): ChunkExtent[] {
  const chunks: ChunkExtent[] = [];
  for (let position = lower; position < upper; ) {
    const chunk = dimension.findChunk(position);
    chunks.push(chunk);
    position = chunk.start + chunk.length;
  }
  return chunks;
}

/**
 * Copies the box `[srcStart, srcStart + size)` of `src`, an array of shape
 * `srcShape`, to `[destStart, destStart + size)` of `dest`, of shape
 * `destShape`. Both are in Fortran order (dimension 0 fastest).
 */
export function copyBox(
  dest: TypedArray,
  destShape: ArrayLike<number>,
  destStart: ArrayLike<number>,
  src: TypedArray,
  srcShape: ArrayLike<number>,
  srcStart: ArrayLike<number>,
  size: ArrayLike<number>,
) {
  const rank = size.length;
  for (let d = 0; d < rank; ++d) if (size[d] === 0) return;
  const destStrides = new Array<number>(rank);
  const srcStrides = new Array<number>(rank);
  let destStride = 1;
  let srcStride = 1;
  let destOffset = 0;
  let srcOffset = 0;
  for (let d = 0; d < rank; ++d) {
    destStrides[d] = destStride;
    srcStrides[d] = srcStride;
    destOffset += destStart[d] * destStride;
    srcOffset += srcStart[d] * srcStride;
    destStride *= destShape[d];
    srcStride *= srcShape[d];
  }
  const rowLength = rank === 0 ? 1 : size[0];
  const position = new Array<number>(rank).fill(0);
  while (true) {
    (dest as Uint8Array).set(
      (src as Uint8Array).subarray(srcOffset, srcOffset + rowLength),
      destOffset,
    );
    let d = 1;
    for (; d < rank; ++d) {
      destOffset += destStrides[d];
      srcOffset += srcStrides[d];
      if (++position[d] < size[d]) break;
      destOffset -= destStrides[d] * size[d];
      srcOffset -= srcStrides[d] * size[d];
      position[d] = 0;
    }
    if (d >= rank) return;
  }
}

/**
 * Widens `chunkShape` to `dataShape` along each of `channelDimensions`
 * (indices into both), in place. Neuroglancer reads every channel of a
 * voxel from one chunk, so a chunk must span its channel dimensions whole.
 */
export function spanChannelDimensions(
  chunkShape: Uint32Array,
  dataShape: ArrayLike<number>,
  channelDimensions: readonly number[],
) {
  for (const i of channelDimensions) {
    chunkShape[i] = Math.max(chunkShape[i], dataShape[i]);
  }
}

/**
 * The chunks along one dimension of a regular grid of chunks of `length`
 * covering `extent`, as a rectilinear dimension (the last chunk may overflow
 * the extent).
 */
export function regularDimension(length: number, extent: number) {
  return new RectilinearDimension([
    [length, Math.max(1, Math.ceil(extent / length))],
  ]);
}

/** A chunk read by `assembleChunk`: its data and its size. */
export interface AssembledChunk {
  data: TypedArray<ArrayBuffer>;
  size: Uint32Array;
}

/**
 * Reads the box `[lower, upper)` of an array (Fortran order) from the zarr
 * chunks it overlaps along each dimension, in `dimensions`, each read by
 * `read` from its extents (undefined if it is missing).
 *
 * When the box is exactly one zarr chunk along each dimension, starting at
 * `lower`, that chunk is returned as decoded, at its own size (which may
 * extend past `upper`), or undefined if it is missing. Otherwise the chunks
 * are read concurrently and their parts within the box copied into
 * `makeOutput(n)`, an array of the box's `n` elements filled with the fill
 * value, which is returned at the box's size. An empty box gives undefined.
 */
export async function assembleChunk(
  lower: readonly number[],
  upper: readonly number[],
  dimensions: readonly RectilinearDimension[],
  read: (
    extents: ChunkExtent[],
  ) => Promise<TypedArray<ArrayBuffer> | undefined>,
  makeOutput: (numElements: number) => TypedArray<ArrayBuffer>,
): Promise<AssembledChunk | undefined> {
  const rank = lower.length;
  const covering: ChunkExtent[][] = [];
  let single = true;
  for (let i = 0; i < rank; ++i) {
    if (upper[i] <= lower[i]) return undefined;
    const chunks = getCoveringChunks(dimensions[i], lower[i], upper[i]);
    covering.push(chunks);
    if (chunks.length !== 1 || chunks[0].start !== lower[i]) single = false;
  }

  if (single) {
    // Exactly one zarr chunk, aligned with the box: decoded in place.
    const extents = covering.map((chunks) => chunks[0]);
    const data = await read(extents);
    if (data === undefined) return undefined;
    return { data, size: Uint32Array.from(extents, (c) => c.length) };
  }

  // Every zarr chunk covering the box.
  const zarrChunks: ChunkExtent[][] = [];
  const visit = (i: number, current: ChunkExtent[]) => {
    if (i === rank) {
      zarrChunks.push(current.slice());
      return;
    }
    for (const c of covering[i]) {
      current[i] = c;
      visit(i + 1, current);
    }
  };
  visit(0, new Array(rank));

  const size = Uint32Array.from(lower, (lo, i) => upper[i] - lo);
  const output = makeOutput(size.reduce((a, b) => a * b, 1));
  const parts = await Promise.all(zarrChunks.map(read));
  for (let k = 0; k < zarrChunks.length; ++k) {
    const data = parts[k];
    if (data === undefined) continue;
    const chunks = zarrChunks[k];
    const destStart = new Array<number>(rank);
    const srcStart = new Array<number>(rank);
    const srcShape = new Array<number>(rank);
    const boxSize = new Array<number>(rank);
    for (let i = 0; i < rank; ++i) {
      const { start, length } = chunks[i];
      const begin = Math.max(lower[i], start);
      const end = Math.min(upper[i], start + length);
      destStart[i] = begin - lower[i];
      srcStart[i] = begin - start;
      srcShape[i] = length;
      boxSize[i] = end - begin;
    }
    copyBox(output, size, destStart, data, srcShape, srcStart, boxSize);
  }
  return { data: output, size };
}
