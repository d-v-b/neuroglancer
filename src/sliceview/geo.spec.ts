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
import { getCrs } from "#src/geo/crs.js";
import type { Affine2d } from "#src/geo/source_warp.js";
import { computeGeoWarpSpec } from "#src/geo/source_warp.js";
import { TransformStatus } from "#src/geo/transform.js";
import { ProjectionParameters } from "#src/projection_parameters.js";
import type { TransformedSource } from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type { GeoTransformedSourceInfo } from "#src/sliceview/geo.js";
import {
  beginGeoMeshFrame,
  computeGeoChunkMesh,
  correctGeoChunkPosition,
  forEachGeoVisibleChunk,
  GeoRenderingMode,
  getGeoChunkMesh,
  getGeoRenderingMode,
  makeGeoTransformedSourceInfo,
} from "#src/sliceview/geo.js";
import { mat4, vec3 } from "#src/util/geom.js";

const CHUNK_SIZE = 1024;

interface TestSource {
  tsource: TransformedSource<any>;
  geo: GeoTransformedSourceInfo;
  globalScale: number;
}

/**
 * Constructs a 2-d warped transformed source, displayed in `displayCrs` with the specified global
 * scale (display CRS units per global voxel).
 */
function makeTestSource(
  sourceCrs: string,
  displayCrs: string,
  pixelToSource: Affine2d,
  size: number,
  globalScale: number,
): TestSource {
  const spec = computeGeoWarpSpec(
    getCrs(sourceCrs),
    getCrs(displayCrs),
    [0, 1],
    pixelToSource,
    [0, 0],
    [size, size],
  );
  const rank = 2;
  const geo = makeGeoTransformedSourceInfo(spec, undefined, rank, [0, 1, 2]);
  const [a00, a10, a01, a11, t0, t1] = spec.multiscaleToDisplay;
  // Chunk layout transform: approximate chunk coordinates -> global voxel coordinates.
  const transform = mat4.create();
  transform[0] = a00 / globalScale;
  transform[1] = a10 / globalScale;
  transform[4] = a01 / globalScale;
  transform[5] = a11 / globalScale;
  transform[12] = t0 / globalScale;
  transform[13] = t1 / globalScale;
  const chunkLayout = new ChunkLayout(
    vec3.fromValues(CHUNK_SIZE, CHUNK_SIZE, 1),
    transform,
    2,
  );
  const numChunks = Math.ceil(size / CHUNK_SIZE);
  const tsource = {
    renderLayer: undefined as any,
    source: {
      spec: {
        rank,
        chunkDataSize: Uint32Array.of(CHUNK_SIZE, CHUNK_SIZE),
        lowerChunkBound: Float32Array.of(0, 0),
        upperChunkBound: Float32Array.of(numChunks, numChunks),
        lowerVoxelBound: Float32Array.of(0, 0),
        upperVoxelBound: Float32Array.of(size, size),
      },
    } as any,
    effectiveVoxelSize: vec3.fromValues(1, 1, 1),
    chunkLayout,
    nonDisplayLowerClipBound: Float32Array.of(-Infinity, -Infinity),
    nonDisplayUpperClipBound: Float32Array.of(Infinity, Infinity),
    lowerClipBound: Float32Array.of(0, 0),
    upperClipBound: Float32Array.of(size, size),
    lowerClipDisplayBound: vec3.fromValues(0, 0, 0),
    upperClipDisplayBound: vec3.fromValues(size, size, 1),
    lowerChunkDisplayBound: vec3.fromValues(0, 0, 0),
    upperChunkDisplayBound: vec3.fromValues(numChunks, numChunks, 1),
    chunkDisplayDimensionIndices: [0, 1, 2],
    layerRank: rank,
    combinedGlobalLocalToChunkTransform: new Float32Array(3 * rank),
    fixedLayerToChunkTransform: new Float32Array(3 * rank),
    curPositionInChunks: new Float32Array(rank),
    fixedPositionWithinChunk: new Uint32Array(rank),
    geo,
  } as TransformedSource<any>;
  return { tsource, geo, globalScale };
}

/**
 * Projection parameters for a north-up cross section centered at the specified display CRS
 * coordinates.
 */
function makeProjection(
  globalScale: number,
  centerX: number,
  centerY: number,
  unitsPerPixel: number,
  size = 512,
  rotation = 0,
) {
  const p = new ProjectionParameters();
  p.width = size;
  p.height = size;
  const cx = centerX / globalScale;
  const cy = centerY / globalScale;
  p.globalPosition = Float32Array.of(cx, cy);
  const voxelsPerPixel = unitsPerPixel / globalScale;
  mat4.identity(p.invViewMatrix);
  const cos = Math.cos(rotation) * voxelsPerPixel;
  const sin = Math.sin(rotation) * voxelsPerPixel;
  p.invViewMatrix[0] = cos;
  p.invViewMatrix[1] = sin;
  p.invViewMatrix[4] = -sin;
  p.invViewMatrix[5] = cos;
  p.invViewMatrix[12] = cx;
  p.invViewMatrix[13] = cy;
  mat4.invert(p.viewMatrix, p.invViewMatrix);
  mat4.ortho(
    p.projectionMat,
    -size / 2,
    size / 2,
    -size / 2,
    size / 2,
    -10,
    10,
  );
  mat4.multiply(p.viewProjectionMat, p.projectionMat, p.viewMatrix);
  mat4.invert(p.invViewProjectionMat, p.viewProjectionMat);
  return p;
}

/**
 * Determines the visible chunks by densely sampling chunk boundaries, including world copies.
 */
function bruteForceVisibleChunks(source: TestSource, p: ProjectionParameters) {
  const { tsource, geo } = source;
  const { transform } = tsource.chunkLayout;
  const n = Math.ceil(tsource.upperClipDisplayBound[0] / CHUNK_SIZE);
  const size = tsource.upperClipDisplayBound[0];
  // Map from visible chunk to the minimum screen distance of the centers of the clip-space bounds
  // of its visible copies.
  const visible = new Map<string, number>();
  const out = new Float64Array(2);
  const period = geo.warp.worldPeriod;
  for (let gx = 0; gx < n; ++gx) {
    for (let gy = 0; gy < n; ++gy) {
      const x0 = gx * CHUNK_SIZE;
      const y0 = gy * CHUNK_SIZE;
      const x1 = Math.min(size, x0 + CHUNK_SIZE);
      const y1 = Math.min(size, y0 + CHUNK_SIZE);
      for (let k = -2; k <= 2; ++k) {
        if (k !== 0 && period === undefined) continue;
        let xMin = Infinity;
        let xMax = -Infinity;
        let yMin = Infinity;
        let yMax = -Infinity;
        const samples = 64;
        for (let i = 0; i <= samples; ++i) {
          const t = i / samples;
          for (const [x, y] of [
            [x0 + t * (x1 - x0), y0],
            [x0 + t * (x1 - x0), y1],
            [x0, y0 + t * (y1 - y0)],
            [x1, y0 + t * (y1 - y0)],
          ]) {
            if (geo.warp.forward(x, y, out) === TransformStatus.INVALID)
              continue;
            let wx = out[0];
            let wy = out[1];
            if (period !== undefined) {
              wx += k * period[0];
              wy += k * period[1];
            }
            const dx = transform[0] * wx + transform[4] * wy + transform[12];
            const dy = transform[1] * wx + transform[5] * wy + transform[13];
            const m = p.viewProjectionMat;
            const clipX = m[0] * dx + m[4] * dy + m[12];
            const clipY = m[1] * dx + m[5] * dy + m[13];
            xMin = Math.min(xMin, clipX);
            xMax = Math.max(xMax, clipX);
            yMin = Math.min(yMin, clipY);
            yMax = Math.max(yMax, clipY);
          }
        }
        if (xMin <= 1 && xMax >= -1 && yMin <= 1 && yMax >= -1) {
          const key = `${gx},${gy}`;
          const distance = Math.hypot(
            ((xMin + xMax) / 2) * (p.width / 2),
            ((yMin + yMax) / 2) * (p.height / 2),
          );
          visible.set(key, Math.min(distance, visible.get(key) ?? Infinity));
        }
      }
    }
  }
  return visible;
}

function getVisibleChunks(source: TestSource, p: ProjectionParameters) {
  const visible = new Map<string, number>();
  forEachGeoVisibleChunk(
    p,
    new Float32Array(0),
    source.tsource,
    source.tsource.chunkLayout,
    (position, screenDistance) => {
      const key = `${position[0]},${position[1]}`;
      expect(visible.has(key), `duplicate chunk ${key}`).toBe(false);
      visible.set(key, screenDistance);
    },
  );
  return visible;
}

/**
 * Wraps `geo.warp.forward` to count the number of calls.
 */
function countForwardCalls(geo: GeoTransformedSourceInfo) {
  const { warp } = geo;
  const forward = warp.forward.bind(warp);
  const counter = { count: 0 };
  warp.forward = (x, y, out) => {
    ++counter.count;
    return forward(x, y, out);
  };
  return counter;
}

// Sentinel-2 tile 33UUU: 10980 x 10980 pixels of 10 m, in UTM zone 33N.
const SENTINEL_TILE: Affine2d = [10, 0, 0, -10, 300000, 5900040];

describe("forEachGeoVisibleChunk", () => {
  it("finds all visible chunks of warped sources", () => {
    const cases: {
      description: string;
      source: TestSource;
      projection: ProjectionParameters;
      minVisible: number;
    }[] = [];
    {
      const source = makeTestSource(
        "EPSG:32633",
        "EPSG:4326",
        SENTINEL_TILE,
        10980,
        1e-4,
      );
      cases.push(
        {
          description: "UTM tile in geographic display, zoomed in",
          source,
          projection: makeProjection(1e-4, 13.5, 52.6, 2e-4),
          minVisible: 1,
        },
        {
          description: "UTM tile in geographic display, zoomed out",
          source,
          projection: makeProjection(1e-4, 13.5, 52.6, 2e-2),
          minVisible: 100,
        },
        {
          description: "UTM tile in geographic display, rotated view",
          source,
          projection: makeProjection(1e-4, 13.5, 52.6, 2e-3, 512, Math.PI / 5),
          minVisible: 4,
        },
        {
          description: "UTM tile in geographic display, outside of view",
          source,
          projection: makeProjection(1e-4, 40, 10, 2e-3),
          minVisible: 0,
        },
      );
    }
    {
      // A source spanning the antimeridian, in UTM zone 1 (central meridian -177).
      const source = makeTestSource(
        "EPSG:32601",
        "EPSG:4326",
        [100, 0, 0, -100, 100000, 7000000],
        8192,
        1e-3,
      );
      cases.push({
        description: "source spanning the antimeridian, viewed across +180",
        source,
        projection: makeProjection(1e-3, 180, 62, 2e-2),
        minVisible: 4,
      });
    }
    {
      const source = makeTestSource(
        "EPSG:4326",
        "EPSG:3413",
        [360 / 4096, 0, 0, -30 / 4096, -180, 90],
        4096,
        100,
      );
      cases.push({
        description: "geographic source around the pole in polar stereographic",
        source,
        projection: makeProjection(100, 0, 0, 5000),
        minVisible: 4,
      });
    }
    for (const { description, source, projection, minVisible } of cases) {
      const expected = bruteForceVisibleChunks(source, projection);
      const actual = getVisibleChunks(source, projection);
      for (const [key, expectedDistance] of expected) {
        expect(actual.has(key), `${description}: missing chunk ${key}`).toBe(
          true,
        );
        // The reported distance is that of the nearest visible copy (up to differences due to the
        // coarser sampling of chunk boundaries).
        expect(
          Math.abs(actual.get(key)! - expectedDistance),
          `${description}: distance of chunk ${key}`,
        ).toBeLessThan(0.05 * projection.width);
      }
      expect(actual.size, description).toBeGreaterThanOrEqual(minVisible);
      // Chunk footprints are tested with a margin, so a few additional chunks may be reported.
      expect(actual.size, description).toBeLessThanOrEqual(
        Math.max(expected.size * 1.5, expected.size + 4),
      );
    }
  });

  it("reuses block footprints across traversals", () => {
    const source = makeTestSource(
      "EPSG:32633",
      "EPSG:4326",
      SENTINEL_TILE,
      10980,
      1e-4,
    );
    const counter = countForwardCalls(source.geo);
    const view = makeProjection(1e-4, 13.5, 52.6, 2e-3);
    const first = getVisibleChunks(source, view);
    const firstCount = counter.count;
    expect(firstCount).toBeGreaterThan(0);
    // Same view: no evaluations of the warp.
    expect(getVisibleChunks(source, view)).toEqual(first);
    expect(counter.count).toBe(firstCount);
    // Panned view: only blocks not visited previously are evaluated.
    const panned = makeProjection(1e-4, 13.55, 52.6, 2e-3);
    const expected = bruteForceVisibleChunks(source, panned);
    counter.count = 0;
    const actual = getVisibleChunks(source, panned);
    for (const key of expected.keys()) {
      expect(actual.has(key), `missing chunk ${key}`).toBe(true);
    }
    expect(counter.count).toBeLessThan(firstCount / 2);
  });

  it("skips sources with too many visible chunks", () => {
    // A fine-resolution source in geographic coordinates (western hemisphere), shown in a north
    // polar stereographic projection.  Near the pole, a small region covers all longitudes, and
    // therefore the entire top row of chunks.
    const source = makeTestSource(
      "EPSG:4326",
      "EPSG:3413",
      [1e-5, 0, 0, -1e-5, -180, 90],
      18000000,
      1,
    );
    const atPole = makeProjection(1, 0, 0, 2);
    expect(getVisibleChunks(source, atPole).size).toBe(0);
    // Away from the pole, the visible chunks are reported.
    const away = makeProjection(1, -1500000, 0, 2);
    expect(getVisibleChunks(source, away).size).toBeGreaterThan(0);
  });

  it("retains the chunk meshes of the current frame", () => {
    // Identity warp, such that meshes are cheap to compute.
    const source = makeTestSource(
      "EPSG:4326",
      "EPSG:4326",
      [1e-4, 0, 0, -1e-4, 13, 52],
      64 * CHUNK_SIZE,
      1e-4,
    );
    const { tsource, geo } = source;
    const { chunkLayout } = tsource;
    const drawFrame = (chunks: number[]) => {
      beginGeoMeshFrame(tsource);
      return chunks.map((i) => {
        const x = i % 64;
        const y = Math.floor(i / 64);
        return getGeoChunkMesh(tsource, chunkLayout, `${x},${y}`, x, y, 0, 1);
      });
    };
    const range = (start: number, end: number) =>
      Array.from({ length: end - start }, (_, i) => start + i);
    // More visible chunks than the minimum cache size: meshes are reused in the next frame.
    const visible = range(0, 3000);
    const first = drawFrame(visible);
    const second = drawFrame(visible);
    for (let i = 0; i < visible.length; ++i) {
      expect(second[i]).toBe(first[i]);
    }
    drawFrame(range(3000, 4096));
    expect(geo.meshCache!.meshes.size).toBe(4096);
    // Once fewer chunks are visible, the cache shrinks to the minimum size, retaining the meshes
    // of the current and previous frame.
    const small = range(0, 1000);
    const third = drawFrame(small);
    drawFrame(small);
    expect(geo.meshCache!.meshes.size).toBe(2048);
    const fourth = drawFrame(small);
    for (let i = 0; i < small.length; ++i) {
      expect(fourth[i]).toBe(third[i]);
    }
    let totalVertices = 0;
    for (const mesh of geo.meshCache!.meshes.values()) {
      totalVertices += mesh.numVertices;
    }
    expect(geo.meshCache!.totalVertices).toBe(totalVertices);
  });

  it("corrects hover positions in world copies", () => {
    const identity = makeTestSource(
      "EPSG:4326",
      "EPSG:4326",
      [1e-3, 0, 0, -1e-3, 178, 66],
      4096,
      1e-3,
    );
    // A source spanning the antimeridian, in UTM zone 1 (central meridian -177).
    const utm = makeTestSource(
      "EPSG:32601",
      "EPSG:4326",
      [100, 0, 0, -100, 100000, 7000000],
      8192,
      1e-3,
    );
    const out = new Float64Array(2);
    for (const [{ geo }, size] of [
      [identity, 4096],
      [utm, 8192],
    ] as const) {
      const { warp } = geo;
      const period = warp.worldPeriod!;
      const lower = [0, 0];
      const upper = [size, size];
      for (const [px, py] of [
        [100.5, 200.5],
        [size - 100.5, 300.5],
      ]) {
        expect(warp.forward(px, py, out)).not.toBe(TransformStatus.INVALID);
        for (const k of [0, -1, 1]) {
          const position = Float32Array.of(
            out[0] + k * period[0],
            out[1] + k * period[1],
          );
          expect(
            correctGeoChunkPosition(warp, position, lower, upper),
            `copy ${k}`,
          ).toBe(true);
          expect(position[0]).toBeCloseTo(px, 1);
          expect(position[1]).toBeCloseTo(py, 1);
        }
      }
    }
  });

  it("rejects hover positions outside of all world copies", () => {
    const source = makeTestSource(
      "EPSG:32601",
      "EPSG:4326",
      [100, 0, 0, -100, 100000, 7000000],
      8192,
      1e-3,
    );
    const { warp } = source.geo;
    const out = new Float64Array(2);
    warp.forward(4096, -2000, out);
    const position = Float32Array.of(out[0], out[1]);
    expect(correctGeoChunkPosition(warp, position, [0, 0], [8192, 8192])).toBe(
      false,
    );
  });

  it("computes chunk meshes covering the clipped chunk", () => {
    const source = makeTestSource(
      "EPSG:32633",
      "EPSG:4326",
      SENTINEL_TILE,
      10980,
      1e-4,
    );
    // Last chunk along x is truncated by the clip bound (10980 = 10 * 1024 + 740).
    const mesh = computeGeoChunkMesh(
      source.tsource,
      source.tsource.chunkLayout,
      10,
      0,
      0,
      1,
    );
    let maxX = 0;
    for (let i = 0; i < mesh.numVertices; ++i) {
      maxX = Math.max(maxX, mesh.positionWithinChunk[2 * i]);
    }
    expect(maxX).toBeCloseTo(740, 6);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it("selects the rendering mode", () => {
    const warped = makeTestSource(
      "EPSG:32633",
      "EPSG:4326",
      SENTINEL_TILE,
      10980,
      1e-4,
    );
    const identity = makeTestSource(
      "EPSG:4326",
      "EPSG:4326",
      [1e-4, 0, 0, -1e-4, 13, 52],
      4096,
      1e-4,
    );
    const mapView = makeProjection(1e-4, 13.5, 52.6, 2e-4);
    // A cross section perpendicular to the map plane.
    const section = makeProjection(1e-4, 13.5, 52.6, 2e-4);
    mat4.rotateX(section.invViewMatrix, section.invViewMatrix, Math.PI / 2);
    mat4.invert(section.viewMatrix, section.invViewMatrix);
    mat4.multiply(
      section.viewProjectionMat,
      section.projectionMat,
      section.viewMatrix,
    );
    section.displayDimensionRenderInfo = { displayRank: 3 } as any;
    const cases: [TestSource, ProjectionParameters, GeoRenderingMode][] = [
      [warped, mapView, GeoRenderingMode.WARPED],
      [identity, mapView, GeoRenderingMode.WARPED],
      [warped, section, GeoRenderingMode.HIDDEN],
      // 2-d source in a section including a third dimension: hidden rather than extruded.
      [identity, section, GeoRenderingMode.HIDDEN],
    ];
    for (const [source, projection, expected] of cases) {
      expect(
        getGeoRenderingMode(
          source.tsource,
          projection,
          source.tsource.chunkLayout,
        ),
      ).toBe(expected);
    }
  });
});
