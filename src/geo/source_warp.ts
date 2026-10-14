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
 * @file Nonlinear warps of georeferenced data sources into a display CRS.
 *
 * Neuroglancer's coordinate transform machinery is affine.  A georeferenced source whose CRS
 * differs from the display CRS is presented to that machinery through an affine approximation `L`
 * (the linearization at the center of the source) of the true mapping `R ∘ A`, where `A` is the
 * affine georeferencing transform from pixel coordinates `m` to source CRS coordinates and `R` is
 * the reprojection from the source CRS to the display CRS.
 *
 * The exact mapping is recovered by the warp
 *
 *     W(m) = L⁻¹(R(A(m)))
 *
 * from true pixel coordinates `m` to "approximate pixel coordinates" `m'`, defined such that
 * applying the affine approximation `L` to `m'` yields the exact display CRS coordinates.  The
 * slice view applies `W` when rendering and when determining visible chunks; everything else
 * continues to use the affine approximation.
 */

import type { Crs } from "#src/geo/crs.js";
import { getCrs } from "#src/geo/crs.js";
import {
  CrsTransform,
  GeographicTransform,
  TransformStatus,
} from "#src/geo/transform.js";
import type { Warp2d } from "#src/geo/warp_mesh.js";

/**
 * 2-d affine transform `[a00, a10, a01, a11, t0, t1]` (column-major 2x3), mapping
 * `(x, y) -> (a00 x + a01 y + t0, a10 x + a11 y + t1)`.
 */
export type Affine2d = [number, number, number, number, number, number];

export function applyAffine2d(
  a: Affine2d | Float64Array,
  x: number,
  y: number,
  out: Float64Array | number[],
) {
  out[0] = a[0] * x + a[2] * y + a[4];
  out[1] = a[1] * x + a[3] * y + a[5];
}

export function invertAffine2d(a: Affine2d): Affine2d {
  const [a00, a10, a01, a11, t0, t1] = a;
  const det = a00 * a11 - a01 * a10;
  if (det === 0 || !Number.isFinite(det)) {
    throw new Error("Singular georeferencing transform");
  }
  const i00 = a11 / det;
  const i01 = -a01 / det;
  const i10 = -a10 / det;
  const i11 = a00 / det;
  return [i00, i10, i01, i11, -(i00 * t0 + i01 * t1), -(i10 * t0 + i11 * t1)];
}

/**
 * Serializable specification of a warp, shared between the frontend and backend.
 */
export interface GeoWarpSpec {
  /**
   * Source CRS specification (as accepted by `getCrs`).
   */
  sourceCrs: string;

  /**
   * Display CRS specification.
   */
  displayCrs: string;

  /**
   * Reference longitude for unwrapping source longitudes.
   */
  referenceLongitude: number;

  /**
   * Indices of the two multiscale (model input) dimensions corresponding to source CRS x and y.
   */
  multiscaleDimensions: [number, number];

  /**
   * Affine transform `A` from multiscale coordinates (of `multiscaleDimensions`) to source CRS
   * coordinates.
   */
  multiscaleToSource: Affine2d;

  /**
   * Affine approximation `L` of the transform from multiscale coordinates to display CRS
   * coordinates.
   */
  multiscaleToDisplay: Affine2d;

  /**
   * Period of the display CRS in x (corresponding to 360 degrees of longitude), if the display CRS
   * is cylindrical.
   */
  displayWorldPeriod: number | undefined;

  /**
   * Bounds `[x0, y0, x1, y1]` of the source in multiscale coordinates.
   */
  multiscaleBounds: [number, number, number, number];
}

/**
 * Warped points farther than this multiple of the source extent from the center of the source are
 * treated as invalid.  Such points arise only near singularities of the display CRS (e.g. the
 * opposite pole of a polar stereographic projection), where the reprojection is not meaningful,
 * and would otherwise cause loss of precision in rendering.
 */
const MAX_WARPED_DISTANCE_FACTOR = 1000;

/**
 * Maximum relative difference between the Jacobian estimates obtained with two different finite
 * difference step sizes for a linearization to be accepted.
 */
const LINEARIZATION_TOLERANCE = 0.02;

/**
 * Minimum value of `|det(J)| / |J|_F^2` (approximately the inverse of the condition number) for a
 * linearization to be accepted.
 */
const MIN_LINEARIZATION_INVERSE_CONDITION = 1e-6;

/**
 * Warp `W` from multiscale coordinates to approximate multiscale coordinates.
 */
export class MultiscaleGeoWarp implements Warp2d {
  readonly crsTransform: CrsTransform;
  readonly sourceToMultiscale: Affine2d;
  readonly displayToMultiscale: Affine2d;
  readonly isIdentity: boolean;
  private temp = new Float64Array(2);

  /**
   * Displacement in approximate multiscale coordinates corresponding to one world period in the
   * display CRS, or `undefined` if the display CRS is not periodic.
   */
  readonly worldPeriod: Float64Array | undefined;

  private centerX: number;
  private centerY: number;
  private maxDistance: number;

  constructor(public spec: GeoWarpSpec) {
    const [x0, y0, x1, y1] = spec.multiscaleBounds;
    this.centerX = 0.5 * (x0 + x1);
    this.centerY = 0.5 * (y0 + y1);
    this.maxDistance =
      MAX_WARPED_DISTANCE_FACTOR *
      Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
    this.crsTransform = new CrsTransform(
      getCrs(spec.sourceCrs),
      getCrs(spec.displayCrs),
      spec.referenceLongitude,
    );
    this.sourceToMultiscale = invertAffine2d(spec.multiscaleToSource);
    this.displayToMultiscale = invertAffine2d(spec.multiscaleToDisplay);
    this.isIdentity =
      this.crsTransform.isIdentity &&
      spec.multiscaleToSource.every(
        (x, i) => x === spec.multiscaleToDisplay[i],
      );
    const { displayWorldPeriod } = spec;
    if (displayWorldPeriod !== undefined) {
      const a = this.displayToMultiscale;
      this.worldPeriod = Float64Array.of(
        a[0] * displayWorldPeriod,
        a[1] * displayWorldPeriod,
      );
    }
  }

  /**
   * Maps multiscale coordinates to display CRS coordinates.
   */
  toDisplay(x: number, y: number, out: Float64Array): TransformStatus {
    const temp = this.temp;
    applyAffine2d(this.spec.multiscaleToSource, x, y, temp);
    return this.crsTransform.forward(temp[0], temp[1], out);
  }

  /**
   * Maps display CRS coordinates to multiscale coordinates.
   */
  fromDisplay(x: number, y: number, out: Float64Array): TransformStatus {
    const temp = this.temp;
    const status = this.crsTransform.inverse(x, y, temp);
    if (status === TransformStatus.INVALID) return status;
    applyAffine2d(this.sourceToMultiscale, temp[0], temp[1], out);
    return status;
  }

  forward(x: number, y: number, out: Float64Array): TransformStatus {
    if (this.isIdentity) {
      out[0] = x;
      out[1] = y;
      return TransformStatus.VALID;
    }
    const status = this.toDisplay(x, y, out);
    if (status === TransformStatus.INVALID) return status;
    applyAffine2d(this.displayToMultiscale, out[0], out[1], out);
    if (
      Math.abs(out[0] - this.centerX) > this.maxDistance ||
      Math.abs(out[1] - this.centerY) > this.maxDistance
    ) {
      return TransformStatus.INVALID;
    }
    return status;
  }

  inverse(x: number, y: number, out: Float64Array): TransformStatus {
    if (this.isIdentity) {
      out[0] = x;
      out[1] = y;
      return TransformStatus.VALID;
    }
    const temp = this.temp;
    applyAffine2d(this.spec.multiscaleToDisplay, x, y, temp);
    return this.fromDisplay(temp[0], temp[1], out);
  }

  /**
   * Invokes `callback` with points, in approximate multiscale coordinates, sampling the image of
   * each pole that lies within the rectangle `[lower, upper]` of multiscale coordinates.
   *
   * In a projected source CRS (e.g. polar stereographic), a pole is a single point, but its image
   * in the display CRS may be a line (e.g. latitude ±90 in geographic coordinates), which extends
   * beyond the image of any finite set of samples around it.
   */
  /**
   * Returns a predicate indicating whether a multiscale position maps into the display domain of
   * the display CRS (see `Crs.displayDomain`).
   */
  makeDisplayDomainTest(): (x: number, y: number) => boolean {
    const [xMin, yMin, xMax, yMax] = this.crsTransform.targetCrs.displayDomain;
    const out = new Float64Array(2);
    return (x, y) =>
      this.toDisplay(x, y, out) !== TransformStatus.INVALID &&
      out[0] >= xMin &&
      out[0] <= xMax &&
      out[1] >= yMin &&
      out[1] <= yMax;
  }

  forEachPoleImage(
    lower: ArrayLike<number>,
    upper: ArrayLike<number>,
    callback: (x: number, y: number) => void,
    numSamples = 64,
  ) {
    const { sourceCrs, targetCrs } = this.crsTransform;
    if (this.isIdentity || sourceCrs.isGeographic) return;
    const source = new GeographicTransform(sourceCrs);
    const display = new GeographicTransform(targetCrs);
    const sourcePoint = new Float64Array(2);
    const m = new Float64Array(2);
    const { referenceLongitude } = this.spec;
    for (const lat of [90, -90]) {
      if (
        source.fromLonLat(referenceLongitude, lat, sourcePoint) !==
        TransformStatus.VALID
      ) {
        continue;
      }
      applyAffine2d(this.sourceToMultiscale, sourcePoint[0], sourcePoint[1], m);
      let inside = true;
      for (let i = 0; i < 2; ++i) {
        const lo = Math.min(lower[i], upper[i]);
        const hi = Math.max(lower[i], upper[i]);
        if (!(m[i] >= lo && m[i] <= hi)) inside = false;
      }
      if (!inside) continue;
      for (let i = 0; i <= numSamples; ++i) {
        const lon = referenceLongitude - 180 + (360 * i) / numSamples;
        if (
          display.fromLonLat(lon, lat, sourcePoint) === TransformStatus.INVALID
        ) {
          continue;
        }
        applyAffine2d(
          this.displayToMultiscale,
          sourcePoint[0],
          sourcePoint[1],
          m,
        );
        if (
          Math.abs(m[0] - this.centerX) > this.maxDistance ||
          Math.abs(m[1] - this.centerY) > this.maxDistance
        ) {
          continue;
        }
        callback(m[0], m[1]);
      }
    }
  }
}

const warpCache = new Map<string, MultiscaleGeoWarp>();
const MAX_CACHED_WARPS = 256;

export function getMultiscaleGeoWarp(spec: GeoWarpSpec): MultiscaleGeoWarp {
  const key = JSON.stringify(spec);
  let warp = warpCache.get(key);
  if (warp === undefined) {
    warp = new MultiscaleGeoWarp(spec);
    warpCache.set(key, warp);
    if (warpCache.size > MAX_CACHED_WARPS) {
      warpCache.delete(warpCache.keys().next().value!);
    }
  }
  return warp;
}

/**
 * Computes the warp specification for a source.
 *
 * @param sourceCrs CRS of the source.
 * @param displayCrs CRS of the display.
 * @param multiscaleToSource Georeferencing transform from multiscale coordinates to source CRS
 *     coordinates.
 * @param lower Lower bound of the source in multiscale coordinates.
 * @param upper Upper bound of the source in multiscale coordinates.
 */
export function computeGeoWarpSpec(
  sourceCrs: Crs,
  displayCrs: Crs,
  multiscaleDimensions: [number, number],
  multiscaleToSource: Affine2d,
  lower: ArrayLike<number>,
  upper: ArrayLike<number>,
): GeoWarpSpec {
  const center = [0.5 * (lower[0] + upper[0]), 0.5 * (lower[1] + upper[1])];
  const sourceCenter = [0, 0];
  applyAffine2d(multiscaleToSource, center[0], center[1], sourceCenter);
  // Determine the reference longitude from the center of the source.
  let referenceLongitude = 0;
  {
    const t = new CrsTransform(sourceCrs, getCrs("EPSG:4326"));
    const out = new Float64Array(2);
    if (
      t.forward(sourceCenter[0], sourceCenter[1], out) !==
      TransformStatus.INVALID
    ) {
      referenceLongitude = out[0];
    }
  }
  const spec: GeoWarpSpec = {
    sourceCrs: sourceCrs.id,
    displayCrs: displayCrs.id,
    referenceLongitude,
    multiscaleDimensions,
    multiscaleToSource,
    multiscaleToDisplay: multiscaleToSource,
    displayWorldPeriod: displayCrs.worldPeriod,
    multiscaleBounds: [lower[0], lower[1], upper[0], upper[1]],
  };
  const crsTransform = new CrsTransform(
    sourceCrs,
    displayCrs,
    referenceLongitude,
  );
  if (crsTransform.isIdentity) {
    return spec;
  }
  // Compute linearization at a valid, well-conditioned point near the center.  Try the center
  // first, then points progressively closer to the corners in case the center is outside the
  // display domain or at a singularity.
  const out0 = new Float64Array(2);
  const outX = new Float64Array(2);
  const outY = new Float64Array(2);
  const toDisplay = (x: number, y: number, out: Float64Array) => {
    const s = [0, 0];
    applyAffine2d(multiscaleToSource, x, y, s);
    return crsTransform.forward(s[0], s[1], out) === TransformStatus.VALID;
  };
  const extentX = Math.max(1, upper[0] - lower[0]);
  const extentY = Math.max(1, upper[1] - lower[1]);
  const hx = extentX * 1e-3;
  const hy = extentY * 1e-3;
  const candidates: [number, number][] = [[center[0], center[1]]];
  for (const f of [0.25, 0.1]) {
    for (const [fx, fy] of [
      [f, f],
      [1 - f, f],
      [f, 1 - f],
      [1 - f, 1 - f],
    ]) {
      candidates.push([lower[0] + fx * extentX, lower[1] + fy * extentY]);
    }
  }
  // Estimates the Jacobian at `(cx, cy)` by forward differences with steps `s * hx` and `s * hy`.
  const jacobian = (cx: number, cy: number, s: number) => {
    if (
      !toDisplay(cx + s * hx, cy, outX) ||
      !toDisplay(cx, cy + s * hy, outY)
    ) {
      return undefined;
    }
    return [
      (outX[0] - out0[0]) / (s * hx),
      (outX[1] - out0[1]) / (s * hx),
      (outY[0] - out0[0]) / (s * hy),
      (outY[1] - out0[1]) / (s * hy),
    ];
  };
  let fallback: Affine2d | undefined;
  for (const [cx, cy] of candidates) {
    if (!toDisplay(cx, cy, out0)) continue;
    const j = jacobian(cx, cy, 1);
    const j2 = jacobian(cx, cy, 2);
    if (j === undefined || j2 === undefined) continue;
    const [a00, a10, a01, a11] = j;
    const det = a00 * a11 - a01 * a10;
    if (det === 0 || !Number.isFinite(det)) continue;
    const affine: Affine2d = [
      a00,
      a10,
      a01,
      a11,
      out0[0] - (a00 * cx + a01 * cy),
      out0[1] - (a10 * cx + a11 * cy),
    ];
    // Reject linearizations at or near singularities of the reprojection (e.g. a pole, at which
    // the longitude is undefined, or a discontinuity of the display CRS), where the finite
    // difference estimate depends on the step size, and ill-conditioned linearizations.
    const norm2 = a00 * a00 + a10 * a10 + a01 * a01 + a11 * a11;
    let diff2 = 0;
    for (let i = 0; i < 4; ++i) diff2 += (j[i] - j2[i]) ** 2;
    if (
      diff2 > LINEARIZATION_TOLERANCE ** 2 * norm2 ||
      Math.abs(det) < MIN_LINEARIZATION_INVERSE_CONDITION * norm2
    ) {
      fallback ??= affine;
      continue;
    }
    spec.multiscaleToDisplay = affine;
    return spec;
  }
  if (fallback !== undefined) {
    spec.multiscaleToDisplay = fallback;
    return spec;
  }
  throw new Error(
    `Source in ${sourceCrs.id} cannot be displayed in ${displayCrs.id}: ` +
      "no part of the source lies within the domain of the display CRS",
  );
}

/**
 * Computes the bounding box, in approximate multiscale coordinates, of the image under the warp of
 * the rectangle `[lower, upper]`, by sampling its boundary densely and its interior on a coarser
 * grid.  For a `MultiscaleGeoWarp`, the images of poles within the rectangle are also included.
 * Returns `undefined` if no point maps to a valid position.
 */
export function computeWarpedBounds(
  warp: Warp2d,
  lower: ArrayLike<number>,
  upper: ArrayLike<number>,
  samplesPerEdge = 256,
  interiorSamplesPerDimension = 32,
): { lower: Float64Array; upper: Float64Array } | undefined {
  const resultLower = Float64Array.of(Infinity, Infinity);
  const resultUpper = Float64Array.of(-Infinity, -Infinity);
  const out = new Float64Array(2);
  const include = (x: number, y: number) => {
    resultLower[0] = Math.min(resultLower[0], x);
    resultLower[1] = Math.min(resultLower[1], y);
    resultUpper[0] = Math.max(resultUpper[0], x);
    resultUpper[1] = Math.max(resultUpper[1], y);
  };
  // Points outside the display domain of the display CRS (e.g. near the antipodal singularity of
  // a polar stereographic projection) are excluded, since they would make the bounds arbitrarily
  // large.
  const inDisplayDomain =
    warp instanceof MultiscaleGeoWarp
      ? warp.makeDisplayDomainTest()
      : () => true;
  const add = (x: number, y: number) => {
    if (warp.forward(x, y, out) === TransformStatus.INVALID) return;
    if (!inDisplayDomain(x, y)) return;
    include(out[0], out[1]);
  };
  const [x0, y0] = [lower[0], lower[1]];
  const [x1, y1] = [upper[0], upper[1]];
  for (let i = 0; i <= samplesPerEdge; ++i) {
    const t = i / samplesPerEdge;
    const x = x0 + t * (x1 - x0);
    const y = y0 + t * (y1 - y0);
    add(x, y0);
    add(x, y1);
    add(x0, y);
    add(x1, y);
  }
  // The interior may map outside the image of the boundary, e.g. if the source contains a pole.
  const n = interiorSamplesPerDimension;
  for (let i = 1; i < n; ++i) {
    const x = x0 + (i / n) * (x1 - x0);
    for (let j = 1; j < n; ++j) {
      add(x, y0 + (j / n) * (y1 - y0));
    }
  }
  if (warp instanceof MultiscaleGeoWarp) {
    warp.forEachPoleImage(lower, upper, include);
  }
  if (!(resultLower[0] <= resultUpper[0])) return undefined;
  return { lower: resultLower, upper: resultUpper };
}

/**
 * Warp in the coordinate space of a single-resolution chunk source.
 *
 * Maps chunk coordinates (of `chunkDimensions`) to approximate chunk coordinates, i.e. the
 * composition `C⁻¹ ∘ W ∘ C`, where `C` is the (affine) chunk-to-multiscale transform.
 */
export class ChunkGeoWarp implements Warp2d {
  readonly chunkToMultiscale: Affine2d;
  readonly multiscaleToChunk: Affine2d;
  private temp = new Float64Array(2);

  /**
   * Displacement in approximate chunk coordinates corresponding to one world period.
   */
  readonly worldPeriod: Float64Array | undefined;

  get isIdentity() {
    return this.multiscaleWarp.isIdentity;
  }

  constructor(
    public multiscaleWarp: MultiscaleGeoWarp,
    public chunkDimensions: [number, number],
    chunkToMultiscaleTransform: Float32Array | Float64Array | undefined,
    rank: number,
  ) {
    const [md0, md1] = multiscaleWarp.spec.multiscaleDimensions;
    const stride = rank + 1;
    const [cd0, cd1] = chunkDimensions;
    if (chunkToMultiscaleTransform === undefined) {
      this.chunkToMultiscale = [1, 0, 0, 1, 0, 0];
    } else {
      const t = chunkToMultiscaleTransform;
      this.chunkToMultiscale = [
        t[cd0 * stride + md0],
        t[cd0 * stride + md1],
        t[cd1 * stride + md0],
        t[cd1 * stride + md1],
        t[rank * stride + md0],
        t[rank * stride + md1],
      ];
    }
    this.multiscaleToChunk = invertAffine2d(this.chunkToMultiscale);
    const { worldPeriod } = multiscaleWarp;
    if (worldPeriod !== undefined) {
      const a = this.multiscaleToChunk;
      this.worldPeriod = Float64Array.of(
        a[0] * worldPeriod[0] + a[2] * worldPeriod[1],
        a[1] * worldPeriod[0] + a[3] * worldPeriod[1],
      );
    }
  }

  forward(x: number, y: number, out: Float64Array): TransformStatus {
    const temp = this.temp;
    applyAffine2d(this.chunkToMultiscale, x, y, temp);
    const status = this.multiscaleWarp.forward(temp[0], temp[1], out);
    if (status === TransformStatus.INVALID) return status;
    applyAffine2d(this.multiscaleToChunk, out[0], out[1], out);
    return status;
  }

  inverse(x: number, y: number, out: Float64Array): TransformStatus {
    const temp = this.temp;
    applyAffine2d(this.chunkToMultiscale, x, y, temp);
    const status = this.multiscaleWarp.inverse(temp[0], temp[1], out);
    if (status === TransformStatus.INVALID) return status;
    applyAffine2d(this.multiscaleToChunk, out[0], out[1], out);
    return status;
  }
}
