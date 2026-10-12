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
 * @file Adaptive triangle meshes for reprojecting a rectangular raster region.
 *
 * Given a nonlinear warp from source (pixel) coordinates to output coordinates, computes a
 * triangulation of a source rectangle such that piecewise-linear interpolation of the warp over
 * each triangle has bounded error.  Rendering the triangles with
 * per-vertex texture coordinates then reprojects the raster on the GPU.
 *
 * The refinement algorithm follows the approach of `@developmentseed/raster-reproject` by Kyle
 * Barron (https://github.com/developmentseed/deck.gl-raster, MIT license), which in turn is
 * derived from Delatin by Vladimir Agafonkin (https://github.com/mapbox/delatin, ISC license):
 * the triangle with the largest error is repeatedly split at its point of maximum error, and
 * Delaunay edge flips maintain mesh quality.
 *
 * Neuroglancer renders each chunk of a volume as a separate mesh.  To avoid cracks (T-junctions)
 * between adjacent chunks, the boundary of each mesh is fixed up front by subdividing each edge of
 * the rectangle independently, using only information about that edge.  Since adjacent chunks
 * compute identical subdivisions of their shared edge, their meshes join exactly.  Interior
 * refinement never splits boundary edges.
 *
 * The warp may be discontinuous, e.g. across the antimeridian when the display CRS is not periodic
 * or the source is unwrapped relative to a reference longitude.  Triangles straddling such a
 * discontinuity ("seam") are refined, like triangles straddling the boundary of the valid domain,
 * and then omitted, leaving a thin gap rather than a triangle smeared across the output.
 */

import { TransformStatus } from "#src/geo/transform.js";

/**
 * Nonlinear warp between source coordinates (pixels) and output coordinates.
 */
export interface Warp2d {
  forward(x: number, y: number, out: Float64Array): TransformStatus;
  inverse(x: number, y: number, out: Float64Array): TransformStatus;
}

export interface WarpMesh {
  numVertices: number;
  /**
   * Source coordinates of each vertex, `[x0, y0, x1, y1, ...]`.
   */
  sourcePositions: Float64Array;
  /**
   * Output coordinates of each vertex, `[x0, y0, x1, y1, ...]`.  Entries for vertices whose output
   * position is invalid are `NaN`; such vertices are not referenced by `indices`.
   */
  outputPositions: Float64Array;
  /**
   * Triangle vertex indices.
   */
  indices: Uint32Array;
  /**
   * Maximum interpolation error (in output coordinates) of the final mesh, estimated from samples.
   */
  maxError: number;
}

export interface WarpMeshOptions {
  /**
   * Maximum interpolation error, in output coordinates.
   */
  maxError?: number;
  /**
   * Maximum number of vertices.  Refinement stops when this is reached.
   */
  maxVertices?: number;
  /**
   * Maximum recursion depth for subdividing boundary edges.
   */
  maxEdgeDepth?: number;
}

export const DEFAULT_WARP_MESH_MAX_ERROR = 0.125;
const DEFAULT_MAX_VERTICES = 2048;
const DEFAULT_MAX_EDGE_DEPTH = 12;

/**
 * Triangles smaller than this area (in square source pixels) are not refined further.
 */
const MIN_TRIANGLE_AREA = 0.25;

/**
 * Triangles straddling the boundary of the valid domain are refined until their area is below the
 * area of the rectangle divided by this value.
 */
const BOUNDARY_REFINEMENT_DIVISIONS = 4096;

/**
 * Error assigned to triangles straddling the boundary of the valid domain, which are refined
 * after triangles with a larger interpolation error.
 */
const BOUNDARY_TRIANGLE_ERROR = 1;

/**
 * Triangles straddling a discontinuity of the warp are refined until their area is below the area
 * of the rectangle divided by this value.
 */
const SEAM_REFINEMENT_DIVISIONS = 262144;

/**
 * Error assigned to triangles straddling a discontinuity of the warp.  These are refined before
 * all other triangles, such that the gap left by omitting them is thin even if refinement is
 * stopped by the vertex limit (e.g. near singularities of the warp).
 */
const SEAM_TRIANGLE_ERROR = 1e30;

/**
 * Edges are tested for a discontinuity only if their length in output coordinates exceeds this
 * multiple of their length in source coordinates (and `SEAM_MIN_JUMP`).  Warps used for rendering
 * are normalized to approximately preserve lengths near the center of the source, such that
 * larger stretch factors arise only near discontinuities and singularities.
 */
const SEAM_MIN_STRETCH = 32;

/**
 * Minimum length, in output coordinates, of a discontinuity.
 */
const SEAM_MIN_JUMP = 1;

/**
 * Bisection of an edge to locate a discontinuity stops once the remaining interval is shorter than
 * this (in source coordinates).
 */
const SEAM_RESOLUTION = 1e-3;

/**
 * An edge is considered to cross a discontinuity if, after bisecting it down to `SEAM_RESOLUTION`,
 * the output length of the interval containing the discontinuity is at least this fraction of the
 * output length of the edge.
 */
const SEAM_JUMP_FRACTION = 0.5;

const tempOut = new Float64Array(2);

// Multiplier for encoding an edge between vertices `u` and `v` as `u * MAX_EDGE_KEY_VERTICES + v`.
const MAX_EDGE_KEY_VERTICES = 2 ** 26;

function isValidStatus(status: TransformStatus) {
  return status !== TransformStatus.INVALID;
}

/**
 * Estimates the error of approximating the warp of source point `(sx, sy)` by the output point
 * `(ox, oy)`, as the distance in output coordinates.  Returns `undefined` if the error cannot be
 * evaluated at this point.
 *
 * The error is measured in output space, rather than in source space as in
 * `@developmentseed/raster-reproject`, because it remains well-defined at singularities of the
 * warp (e.g. a row of source pixels that collapses to a pole) and does not depend on the inverse
 * warp.  Warps used for rendering are normalized such that output coordinates are approximately
 * source pixels near the center of the source.
 */
function sampleError(
  warp: Warp2d,
  sx: number,
  sy: number,
  ox: number,
  oy: number,
): number | undefined {
  if (warp.forward(sx, sy, tempOut) !== TransformStatus.VALID) {
    // Point is invalid or clamped to the boundary of the output domain; interpolation error is
    // not meaningful.
    return undefined;
  }
  return Math.hypot(tempOut[0] - ox, tempOut[1] - oy);
}

/**
 * Subdivides the edge from `a` to `b`.  Returns the parameters `t` in `(0, 1)` of the inserted
 * points, in increasing order.  The result depends only on `a`, `b`, and the warp, which ensures
 * that adjacent meshes sharing the edge agree exactly, provided `a` and `b` are specified in the
 * same (canonical) order.
 */
function subdivideEdge(
  warp: Warp2d,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  maxError: number,
  maxDepth: number,
): number[] {
  const result: number[] = [];
  const dx = bx - ax;
  const dy = by - ay;
  const outA = new Float64Array(2);
  const outB = new Float64Array(2);
  const statusA = warp.forward(ax, ay, outA);
  const statusB = warp.forward(bx, by, outB);
  const recurse = (
    t0: number,
    o0x: number,
    o0y: number,
    s0: TransformStatus,
    t1: number,
    o1x: number,
    o1y: number,
    s1: TransformStatus,
    depth: number,
  ) => {
    if (depth >= maxDepth) return;
    const tm = 0.5 * (t0 + t1);
    const mx = ax + tm * dx;
    const my = ay + tm * dy;
    const sm = warp.forward(mx, my, tempOut);
    const omx = tempOut[0];
    const omy = tempOut[1];
    let split = false;
    const valid0 = isValidStatus(s0);
    const valid1 = isValidStatus(s1);
    const validM = isValidStatus(sm);
    if (valid0 && valid1) {
      if (!validM) {
        split = true;
      } else {
        // Check midpoint and quarter points.
        for (const f of [0.25, 0.5, 0.75]) {
          const t = t0 + f * (t1 - t0);
          const error = sampleError(
            warp,
            ax + t * dx,
            ay + t * dy,
            o0x + f * (o1x - o0x),
            o0y + f * (o1y - o0y),
          );
          if (error !== undefined && error > maxError) {
            split = true;
            break;
          }
        }
      }
    } else if (valid0 !== valid1 || validM) {
      // Localize the boundary of the valid domain.
      split = true;
    }
    if (!split) return;
    recurse(t0, o0x, o0y, s0, tm, omx, omy, sm, depth + 1);
    result.push(tm);
    recurse(tm, omx, omy, sm, t1, o1x, o1y, s1, depth + 1);
  };
  recurse(0, outA[0], outA[1], statusA, 1, outB[0], outB[1], statusB, 0);
  return result;
}

/**
 * Determines whether the warp is discontinuous along the edge from source point `a` to `b`, with
 * output positions `oa` and `ob`.
 *
 * A continuous warp maps short intervals to short intervals, while across a discontinuity the
 * output length of an interval does not decrease as it shrinks.  The edge is bisected repeatedly,
 * keeping the half with the longer output length.
 */
function isDiscontinuous(
  warp: Warp2d,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  oax: number,
  oay: number,
  obx: number,
  oby: number,
): boolean {
  const length = Math.hypot(bx - ax, by - ay);
  const jump = Math.hypot(obx - oax, oby - oay);
  if (!(jump > Math.max(SEAM_MIN_STRETCH * length, SEAM_MIN_JUMP))) {
    return false;
  }
  const minJump = SEAM_JUMP_FRACTION * jump;
  let t0 = 0;
  let t1 = 1;
  let o0x = oax;
  let o0y = oay;
  let o1x = obx;
  let o1y = oby;
  while ((t1 - t0) * length > SEAM_RESOLUTION) {
    const tm = 0.5 * (t0 + t1);
    if (
      warp.forward(ax + tm * (bx - ax), ay + tm * (by - ay), tempOut) ===
      TransformStatus.INVALID
    ) {
      return false;
    }
    const omx = tempOut[0];
    const omy = tempOut[1];
    const d0 = Math.hypot(omx - o0x, omy - o0y);
    const d1 = Math.hypot(o1x - omx, o1y - omy);
    if (d0 >= d1) {
      if (d0 < minJump) return false;
      t1 = tm;
      o1x = omx;
      o1y = omy;
    } else {
      if (d1 < minJump) return false;
      t0 = tm;
      o0x = omx;
      o0y = omy;
    }
  }
  return true;
}

function compareLexicographic(ax: number, ay: number, bx: number, by: number) {
  return ax < bx || (ax === bx && ay < by);
}

/**
 * Appends the points subdividing the edge from `a` to `b`, excluding `a` and `b`, in order from
 * `a` to `b`.
 */
function appendEdgePoints(
  points: number[],
  warp: Warp2d,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  maxError: number,
  maxDepth: number,
) {
  // Subdivide in canonical orientation so that both meshes sharing this edge agree exactly.
  const forwardOrder = compareLexicographic(ax, ay, bx, by);
  const [cx0, cy0, cx1, cy1] = forwardOrder
    ? [ax, ay, bx, by]
    : [bx, by, ax, ay];
  const ts = subdivideEdge(warp, cx0, cy0, cx1, cy1, maxError, maxDepth);
  const n = ts.length;
  const dx = cx1 - cx0;
  const dy = cy1 - cy0;
  for (let i = 0; i < n; ++i) {
    const t = ts[forwardOrder ? i : n - 1 - i];
    points.push(cx0 + t * dx, cy0 + t * dy);
  }
}

// Barycentric sample points used to estimate the error of each triangle.  The edge midpoints
// correspond to edges 0 (v0-v1), 1 (v1-v2), and 2 (v2-v0), and are only sampled for interior
// edges.
const CENTROID: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];
const EDGE_MIDPOINTS: [number, number, number][] = [
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
];

function orient(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - cx) * (ay - cy) - (by - cy) * (ax - cx);
}

function inCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  const dx = ax - px;
  const dy = ay - py;
  const ex = bx - px;
  const ey = by - py;
  const fx = cx - px;
  const fy = cy - py;

  const ap = dx * dx + dy * dy;
  const bp = ex * ex + ey * ey;
  const cp = fx * fx + fy * fy;

  return (
    dx * (ey * cp - bp * fy) -
      dy * (ex * cp - bp * fx) +
      ap * (ex * fy - ey * fx) <
    0
  );
}

class MeshBuilder {
  positions: number[] = [];
  outputs: number[] = [];
  outputStatus: TransformStatus[] = [];
  triangles: number[] = [];
  // Indicates for each triangle whether it straddles a discontinuity of the warp.
  seams: boolean[] = [];
  // Results of `isDiscontinuous` for edges, keyed by `edgeKey`.
  discontinuousEdges = new Map<number, boolean>();
  halfedges: number[] = [];
  candidates: number[] = [];
  queueIndices: number[] = [];
  queue: number[] = [];
  errors: number[] = [];
  pending: number[] = [];
  // Index in `pending` of each triangle, if it is pending (valid only if `pending` at that index
  // refers back to the triangle).
  pendingIndices: number[] = [];
  pendingLen = 0;

  constructor(
    public warp: Warp2d,
    public maxError: number,
    public minBoundaryTriangleArea: number,
    public minSeamTriangleArea: number,
  ) {}

  addPoint(x: number, y: number): number {
    const i = this.positions.length >> 1;
    this.positions.push(x, y);
    const status = this.warp.forward(x, y, tempOut);
    this.outputStatus.push(status);
    if (isValidStatus(status)) {
      this.outputs.push(tempOut[0], tempOut[1]);
    } else {
      this.outputs.push(Number.NaN, Number.NaN);
    }
    return i;
  }

  seedFan(ring: number[], center: number) {
    const n = ring.length;
    for (let i = 0; i < n; ++i) {
      const bi = ring[i];
      const bnext = ring[(i + 1) % n];
      // Triangle i = [b_{i+1}, b_i, C].
      // Edge 0: b_{i+1} -> b_i (boundary).
      // Edge 1: b_i -> C, twin is edge 2 of triangle i-1.
      // Edge 2: C -> b_{i+1}, twin is edge 1 of triangle i+1.
      const e = 3 * i;
      this.triangles[e] = bnext;
      this.triangles[e + 1] = bi;
      this.triangles[e + 2] = center;
      this.halfedges[e] = -1;
      this.halfedges[e + 1] = 3 * ((i + n - 1) % n) + 2;
      this.halfedges[e + 2] = 3 * ((i + 1) % n) + 1;
    }
    for (let t = 0; t < n; ++t) {
      this.candidates[2 * t] = 0;
      this.candidates[2 * t + 1] = 0;
      this.queueIndices[t] = -1;
      this.pendingIndices[t] = this.pendingLen;
      this.pending[this.pendingLen++] = t;
    }
    for (let t = 0; t < n; ++t) {
      this.legalize(3 * t + 1);
    }
  }

  seedQuad(p0: number, p1: number, p2: number, p3: number) {
    // p0=(x0,y0) p1=(x1,y0) p2=(x0,y1) p3=(x1,y1); t0 = (p3, p0, p2), t1 = (p0, p3, p1).
    this.triangles.push(p3, p0, p2, p0, p3, p1);
    this.halfedges.push(3, -1, -1, 0, -1, -1);
    for (let t = 0; t < 2; ++t) {
      this.candidates[2 * t] = 0;
      this.candidates[2 * t + 1] = 0;
      this.queueIndices[t] = -1;
      this.pendingIndices[t] = this.pendingLen;
      this.pending[this.pendingLen++] = t;
    }
  }

  flush() {
    for (let i = 0; i < this.pendingLen; i++) {
      this.findCandidate(this.pending[i]);
    }
    this.pendingLen = 0;
  }

  getMaxError(): number {
    return this.errors.length === 0 ? 0 : this.errors[0];
  }

  private findCandidate(t: number) {
    const { triangles, positions, outputs, outputStatus, halfedges, warp } =
      this;
    const a = triangles[t * 3];
    const b = triangles[t * 3 + 1];
    const c = triangles[t * 3 + 2];
    const p0x = positions[2 * a];
    const p0y = positions[2 * a + 1];
    const p1x = positions[2 * b];
    const p1y = positions[2 * b + 1];
    const p2x = positions[2 * c];
    const p2y = positions[2 * c + 1];
    let maxError = 0;
    let maxX = 0;
    let maxY = 0;
    const area = 0.5 * Math.abs(orient(p0x, p0y, p1x, p1y, p2x, p2y));
    const numValid =
      (isValidStatus(outputStatus[a]) ? 1 : 0) +
      (isValidStatus(outputStatus[b]) ? 1 : 0) +
      (isValidStatus(outputStatus[c]) ? 1 : 0);
    const isSeam = numValid === 3 && this.straddlesSeam(a, b, c);
    this.seams[t] = isSeam;
    if (isSeam) {
      // Refine to localize the discontinuity, such that the gap left by omitting this triangle is
      // thin.  The interpolation error is not meaningful.
      if (area >= this.minSeamTriangleArea) {
        maxError = SEAM_TRIANGLE_ERROR;
        maxX = (p0x + p1x + p2x) / 3;
        maxY = (p0y + p1y + p2y) / 3;
      }
    } else if (numValid !== 0 && numValid !== 3) {
      // Triangle straddles the boundary of the valid domain: refine to localize the boundary, such
      // that valid regions are not omitted.
      if (area >= this.minBoundaryTriangleArea) {
        maxError = BOUNDARY_TRIANGLE_ERROR;
        maxX = (p0x + p1x + p2x) / 3;
        maxY = (p0y + p1y + p2y) / 3;
      }
    } else if (
      area >= MIN_TRIANGLE_AREA &&
      isValidStatus(outputStatus[a]) &&
      isValidStatus(outputStatus[b]) &&
      isValidStatus(outputStatus[c])
    ) {
      const o0x = outputs[2 * a];
      const o0y = outputs[2 * a + 1];
      const o1x = outputs[2 * b];
      const o1y = outputs[2 * b + 1];
      const o2x = outputs[2 * c];
      const o2y = outputs[2 * c + 1];
      const evaluate = (w: [number, number, number]) => {
        const [w0, w1, w2] = w;
        const sx = w0 * p0x + w1 * p1x + w2 * p2x;
        const sy = w0 * p0y + w1 * p1y + w2 * p2y;
        const error = sampleError(
          warp,
          sx,
          sy,
          w0 * o0x + w1 * o1x + w2 * o2x,
          w0 * o0y + w1 * o1y + w2 * o2y,
        );
        if (error !== undefined && error > maxError) {
          maxError = error;
          maxX = sx;
          maxY = sy;
        }
      };
      evaluate(CENTROID);
      for (let edge = 0; edge < 3; ++edge) {
        if (halfedges[t * 3 + edge] < 0) continue;
        evaluate(EDGE_MIDPOINTS[edge]);
      }
    }
    this.candidates[2 * t] = maxX;
    this.candidates[2 * t + 1] = maxY;
    this.queuePush(t, maxError);
  }

  private straddlesSeam(a: number, b: number, c: number): boolean {
    const { positions: p, outputs: o, warp } = this;
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const [u, v] = i < j ? [i, j] : [j, i];
      const key = u * MAX_EDGE_KEY_VERTICES + v;
      let result = this.discontinuousEdges.get(key);
      if (result === undefined) {
        result = isDiscontinuous(
          warp,
          p[2 * u],
          p[2 * u + 1],
          p[2 * v],
          p[2 * v + 1],
          o[2 * u],
          o[2 * u + 1],
          o[2 * v],
          o[2 * v + 1],
        );
        this.discontinuousEdges.set(key, result);
      }
      if (result) return true;
    }
    return false;
  }

  step() {
    const t = this.queuePop();
    const e0 = t * 3;
    const e1 = t * 3 + 1;
    const e2 = t * 3 + 2;
    const { triangles, positions } = this;
    const p0 = triangles[e0];
    const p1 = triangles[e1];
    const p2 = triangles[e2];
    const ax = positions[2 * p0];
    const ay = positions[2 * p0 + 1];
    const bx = positions[2 * p1];
    const by = positions[2 * p1 + 1];
    const cx = positions[2 * p2];
    const cy = positions[2 * p2 + 1];
    const px = this.candidates[2 * t];
    const py = this.candidates[2 * t + 1];
    const pn = this.addPoint(px, py);
    if (orient(ax, ay, bx, by, px, py) === 0) {
      this.handleCollinear(pn, e0);
    } else if (orient(bx, by, cx, cy, px, py) === 0) {
      this.handleCollinear(pn, e1);
    } else if (orient(cx, cy, ax, ay, px, py) === 0) {
      this.handleCollinear(pn, e2);
    } else {
      const h0 = this.halfedges[e0];
      const h1 = this.halfedges[e1];
      const h2 = this.halfedges[e2];
      const t0 = this.addTriangle(p0, p1, pn, h0, -1, -1, e0);
      const t1 = this.addTriangle(p1, p2, pn, h1, -1, t0 + 1);
      const t2 = this.addTriangle(p2, p0, pn, h2, t0 + 2, t1 + 1);
      this.legalize(t0);
      this.legalize(t1);
      this.legalize(t2);
    }
    this.flush();
  }

  private addTriangle(
    a: number,
    b: number,
    c: number,
    ab: number,
    bc: number,
    ca: number,
    e: number = this.triangles.length,
  ) {
    const t = e / 3;
    const { triangles, halfedges } = this;
    triangles[e] = a;
    triangles[e + 1] = b;
    triangles[e + 2] = c;
    halfedges[e] = ab;
    halfedges[e + 1] = bc;
    halfedges[e + 2] = ca;
    if (ab >= 0) halfedges[ab] = e;
    if (bc >= 0) halfedges[bc] = e + 1;
    if (ca >= 0) halfedges[ca] = e + 2;
    this.candidates[2 * t] = 0;
    this.candidates[2 * t + 1] = 0;
    this.queueIndices[t] = -1;
    this.pendingIndices[t] = this.pendingLen;
    this.pending[this.pendingLen++] = t;
    return e;
  }

  private legalize(a: number) {
    const { halfedges, triangles, positions } = this;
    const b = halfedges[a];
    if (b < 0) return;
    const a0 = a - (a % 3);
    const b0 = b - (b % 3);
    const al = a0 + ((a + 1) % 3);
    const ar = a0 + ((a + 2) % 3);
    const bl = b0 + ((b + 2) % 3);
    const br = b0 + ((b + 1) % 3);
    const p0 = triangles[ar];
    const pr = triangles[a];
    const pl = triangles[al];
    const p1 = triangles[bl];
    if (
      !inCircle(
        positions[2 * p0],
        positions[2 * p0 + 1],
        positions[2 * pr],
        positions[2 * pr + 1],
        positions[2 * pl],
        positions[2 * pl + 1],
        positions[2 * p1],
        positions[2 * p1 + 1],
      )
    ) {
      return;
    }
    const hal = halfedges[al];
    const har = halfedges[ar];
    const hbl = halfedges[bl];
    const hbr = halfedges[br];
    this.queueRemove(a0 / 3);
    this.queueRemove(b0 / 3);
    const t0 = this.addTriangle(p0, p1, pl, -1, hbl, hal, a0);
    const t1 = this.addTriangle(p1, p0, pr, t0, har, hbr, b0);
    this.legalize(t0 + 1);
    this.legalize(t1 + 2);
  }

  private handleCollinear(pn: number, a: number) {
    const { halfedges, triangles } = this;
    const a0 = a - (a % 3);
    const al = a0 + ((a + 1) % 3);
    const ar = a0 + ((a + 2) % 3);
    const p0 = triangles[ar];
    const pr = triangles[a];
    const pl = triangles[al];
    const hal = halfedges[al];
    const har = halfedges[ar];
    const b = halfedges[a];
    if (b < 0) {
      // Boundary edges are never split since candidates are never sampled on them; this path is
      // only reached due to floating-point coincidences.
      const t0 = this.addTriangle(pn, p0, pr, -1, har, -1, a0);
      const t1 = this.addTriangle(p0, pn, pl, t0, -1, hal);
      this.legalize(t0 + 1);
      this.legalize(t1 + 2);
      return;
    }
    const b0 = b - (b % 3);
    const bl = b0 + ((b + 2) % 3);
    const br = b0 + ((b + 1) % 3);
    const p1 = triangles[bl];
    const hbl = halfedges[bl];
    const hbr = halfedges[br];
    this.queueRemove(b0 / 3);
    const t0 = this.addTriangle(p0, pr, pn, har, -1, -1, a0);
    const t1 = this.addTriangle(pr, p1, pn, hbr, -1, t0 + 1, b0);
    const t2 = this.addTriangle(p1, pl, pn, hbl, -1, t1 + 1);
    const t3 = this.addTriangle(pl, p0, pn, hal, t0 + 2, t2 + 1);
    this.legalize(t0);
    this.legalize(t1);
    this.legalize(t2);
    this.legalize(t3);
  }

  // Priority queue (max-heap on error).

  private queuePush(t: number, error: number) {
    const i = this.queue.length;
    this.queueIndices[t] = i;
    this.queue.push(t);
    this.errors.push(error);
    this.queueUp(i);
  }

  private queuePop(): number {
    const n = this.queue.length - 1;
    this.queueSwap(0, n);
    this.queueDown(0, n);
    return this.queuePopBack();
  }

  private queuePopBack(): number {
    const t = this.queue.pop()!;
    this.errors.pop();
    this.queueIndices[t] = -1;
    return t;
  }

  private queueRemove(t: number) {
    const i = this.queueIndices[t];
    if (i < 0) {
      const { pending, pendingIndices } = this;
      const it = pendingIndices[t];
      if (!(it >= 0 && it < this.pendingLen && pending[it] === t)) {
        throw new Error("Broken triangulation");
      }
      const last = pending[--this.pendingLen];
      pending[it] = last;
      pendingIndices[last] = it;
      return;
    }
    const n = this.queue.length - 1;
    if (n !== i) {
      this.queueSwap(i, n);
      if (!this.queueDown(i, n)) {
        this.queueUp(i);
      }
    }
    this.queuePopBack();
  }

  private queueLess(i: number, j: number): boolean {
    return this.errors[i] > this.errors[j];
  }

  private queueSwap(i: number, j: number) {
    const { queue, queueIndices, errors } = this;
    const pi = queue[i];
    const pj = queue[j];
    queue[i] = pj;
    queue[j] = pi;
    queueIndices[pi] = j;
    queueIndices[pj] = i;
    const e = errors[i];
    errors[i] = errors[j];
    errors[j] = e;
  }

  private queueUp(j0: number) {
    let j = j0;
    while (true) {
      const i = (j - 1) >> 1;
      if (i === j || i < 0 || !this.queueLess(j, i)) break;
      this.queueSwap(i, j);
      j = i;
    }
  }

  private queueDown(i0: number, n: number): boolean {
    let i = i0;
    while (true) {
      const j1 = 2 * i + 1;
      if (j1 >= n || j1 < 0) break;
      const j2 = j1 + 1;
      let j = j1;
      if (j2 < n && this.queueLess(j2, j1)) j = j2;
      if (!this.queueLess(j, i)) break;
      this.queueSwap(i, j);
      i = j;
    }
    return i > i0;
  }
}

/**
 * Computes an adaptive mesh covering the source rectangle `[x0, x1] x [y0, y1]`.
 */
export function computeWarpMesh(
  warp: Warp2d,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  options: WarpMeshOptions = {},
): WarpMesh {
  const {
    maxError = DEFAULT_WARP_MESH_MAX_ERROR,
    maxVertices = DEFAULT_MAX_VERTICES,
    maxEdgeDepth = DEFAULT_MAX_EDGE_DEPTH,
  } = options;
  const area = Math.abs(x1 - x0) * Math.abs(y1 - y0);
  const builder = new MeshBuilder(
    warp,
    maxError,
    Math.max(MIN_TRIANGLE_AREA, area / BOUNDARY_REFINEMENT_DIVISIONS),
    Math.max(MIN_TRIANGLE_AREA, area / SEAM_REFINEMENT_DIVISIONS),
  );

  // Boundary ring: corners in order (x0,y0) -> (x1,y0) -> (x1,y1) -> (x0,y1), with edge
  // subdivision points in between.
  const corners = [x0, y0, x1, y0, x1, y1, x0, y1];
  const ringPoints: number[] = [];
  const cornerRingIndices: number[] = [];
  for (let i = 0; i < 4; ++i) {
    const ax = corners[2 * i];
    const ay = corners[2 * i + 1];
    const j = (i + 1) % 4;
    const bx = corners[2 * j];
    const by = corners[2 * j + 1];
    cornerRingIndices.push(ringPoints.length / 2);
    ringPoints.push(ax, ay);
    appendEdgePoints(ringPoints, warp, ax, ay, bx, by, maxError, maxEdgeDepth);
  }
  const ring: number[] = [];
  for (let i = 0, n = ringPoints.length / 2; i < n; ++i) {
    ring.push(builder.addPoint(ringPoints[2 * i], ringPoints[2 * i + 1]));
  }
  if (ring.length === 4) {
    builder.seedQuad(ring[0], ring[1], ring[3], ring[2]);
  } else {
    const center = builder.addPoint(0.5 * (x0 + x1), 0.5 * (y0 + y1));
    builder.seedFan(ring, center);
  }
  builder.flush();

  while (
    builder.getMaxError() > maxError &&
    builder.positions.length / 2 < maxVertices
  ) {
    builder.step();
  }

  const { triangles, outputStatus, seams } = builder;
  const indices: number[] = [];
  for (let i = 0, n = triangles.length; i < n; i += 3) {
    const a = triangles[i];
    const b = triangles[i + 1];
    const c = triangles[i + 2];
    if (
      !seams[i / 3] &&
      isValidStatus(outputStatus[a]) &&
      isValidStatus(outputStatus[b]) &&
      isValidStatus(outputStatus[c])
    ) {
      indices.push(a, b, c);
    }
  }
  return {
    numVertices: builder.positions.length / 2,
    sourcePositions: Float64Array.from(builder.positions),
    outputPositions: Float64Array.from(builder.outputs),
    indices: Uint32Array.from(indices),
    maxError: builder.getMaxError(),
  };
}
