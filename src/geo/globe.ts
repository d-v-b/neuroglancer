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
 * @file Geometry of the 3-d globe view: the WGS84 ellipsoid in Earth-centered, Earth-fixed (ECEF)
 * coordinates, and the orbit camera of the perspective panel in globe mode.
 *
 * Rendering in globe mode uses "render coordinates": ECEF coordinates (meters) relative to the
 * target point of the camera on the Earth's surface.  Since the magnitude of render coordinates is
 * small near the target, they can be represented in single precision on the GPU; geometry is
 * provided in ECEF coordinates split into high and low single-precision parts, and the target is
 * subtracted in the vertex shader ("relative to eye" rendering).
 */

import type { quat } from "#src/util/geom.js";
import { mat4, vec3 } from "#src/util/geom.js";

export const WGS84_SEMI_MAJOR_AXIS = 6378137;
export const WGS84_FLATTENING = 1 / 298.257223563;
export const WGS84_SEMI_MINOR_AXIS =
  WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_FLATTENING);
const E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const DEG = Math.PI / 180;

/**
 * Converts geodetic coordinates (degrees, and height in meters above the ellipsoid) to ECEF
 * coordinates (meters).
 */
export function geodeticToEcef(
  lon: number,
  lat: number,
  height: number,
  out: Float64Array | number[],
  offset = 0,
) {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  out[offset] = (n + height) * cosPhi * Math.cos(lambda);
  out[offset + 1] = (n + height) * cosPhi * Math.sin(lambda);
  out[offset + 2] = (n * (1 - E2) + height) * sinPhi;
  return out;
}

/**
 * Converts ECEF coordinates to geodetic `[lon, lat, height]` (degrees, meters), using Bowring's
 * method with one refinement step (accurate to well below a millimeter near the surface).
 */
export function ecefToGeodetic(
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
) {
  const a = WGS84_SEMI_MAJOR_AXIS;
  const b = WGS84_SEMI_MINOR_AXIS;
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  if (p < 1e-9) {
    out[0] = 0;
    out[1] = z >= 0 ? 90 : -90;
    out[2] = Math.abs(z) - b;
    return out;
  }
  let theta = Math.atan2(z * a, p * b);
  let phi = 0;
  for (let i = 0; i < 2; ++i) {
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    phi = Math.atan2(z + ep2 * b * sinT ** 3, p - E2 * a * cosT ** 3);
    theta = Math.atan2(b * Math.tan(phi), a);
  }
  const sinPhi = Math.sin(phi);
  const n = a / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  out[0] = lon / DEG;
  out[1] = phi / DEG;
  out[2] = p / Math.cos(phi) - n;
  return out;
}

/**
 * Returns the unit east, north, and up vectors (in ECEF coordinates) at a geodetic position, as a
 * column-major 3x3 matrix `[e, n, u]`.
 */
export function getEnuBasis(lon: number, lat: number): Float64Array {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinL = Math.sin(lambda);
  const cosL = Math.cos(lambda);
  return Float64Array.of(
    -sinL,
    cosL,
    0,
    -sinPhi * cosL,
    -sinPhi * sinL,
    cosPhi,
    cosPhi * cosL,
    cosPhi * sinL,
    sinPhi,
  );
}

/**
 * Splits double-precision values into high and low single-precision parts (`high + low` equals the
 * value to about 1e-7 relative precision of `low`).
 */
export function splitDouble(
  values: ArrayLike<number>,
  high: Float32Array,
  low: Float32Array,
) {
  for (let i = 0; i < values.length; ++i) {
    const v = values[i];
    const h = Math.fround(v);
    high[i] = h;
    low[i] = v - h;
  }
}

/**
 * Minimum and maximum distances in meters between the camera and its target.
 */
export const GLOBE_MIN_CAMERA_DISTANCE = 20;
export const GLOBE_MAX_CAMERA_DISTANCE = 6e7;

const GLOBE_FIELD_OF_VIEW = Math.PI / 4;

export interface GlobeCameraParameters {
  /**
   * Geodetic coordinates (degrees) of the target point on the surface.
   */
  lon: number;
  lat: number;
  /**
   * Distance in meters between the camera and the target.
   */
  distance: number;
  /**
   * Orientation of the camera relative to the local east-north-up frame at the target.  The
   * identity orientation looks straight down, with north up on the screen.
   */
  orientation: quat;
  width: number;
  height: number;
}

export interface GlobeCamera {
  /**
   * ECEF coordinates of the target.
   */
  target: Float64Array;
  /**
   * ECEF coordinates of the camera.
   */
  eye: Float64Array;
  /**
   * Transform from camera coordinates to render coordinates (ECEF relative to the target).
   */
  invViewMatrix: mat4;
  projectionMat: mat4;
  near: number;
  far: number;
}

/**
 * Computes the orbit camera of the globe view.
 */
export function computeGlobeCamera(params: GlobeCameraParameters): GlobeCamera {
  const { lon, lat, orientation, width, height } = params;
  const distance = Math.min(
    GLOBE_MAX_CAMERA_DISTANCE,
    Math.max(GLOBE_MIN_CAMERA_DISTANCE, params.distance),
  );
  const target = geodeticToEcef(
    lon,
    lat,
    0,
    new Float64Array(3),
  ) as Float64Array;
  const enu = getEnuBasis(lon, lat);
  // Camera axes in the east-north-up frame.
  const axes: number[][] = [];
  for (const axis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const v = vec3.transformQuat(
      vec3.create(),
      vec3.fromValues(axis[0], axis[1], axis[2]),
      orientation,
    );
    // Convert to ECEF.
    axes.push(
      [0, 1, 2].map(
        (i) => enu[i] * v[0] + enu[3 + i] * v[1] + enu[6 + i] * v[2],
      ),
    );
  }
  const [right, up, back] = axes;
  // The camera looks along -back from distance `distance`.
  const eyeRender = back.map((x) => x * distance);
  const invViewMatrix = mat4.create();
  for (let i = 0; i < 3; ++i) {
    invViewMatrix[i] = right[i];
    invViewMatrix[4 + i] = up[i];
    invViewMatrix[8 + i] = back[i];
    invViewMatrix[12 + i] = eyeRender[i];
  }
  const eye = Float64Array.from(target, (t, i) => t + eyeRender[i]);
  // Depth range: from a fraction of the altitude of the camera to beyond the horizon (and deep
  // enough below it to show features in the Earth's interior).
  const eyeRadius = Math.hypot(eye[0], eye[1], eye[2]);
  const altitude = Math.max(1, eyeRadius - WGS84_SEMI_MINOR_AXIS);
  const horizonDistance = Math.sqrt(
    Math.max(0, eyeRadius * eyeRadius - WGS84_SEMI_MINOR_AXIS ** 2),
  );
  const near = Math.max(1, Math.min(altitude, distance) * 0.05);
  const far = Math.max(
    near * 10,
    horizonDistance + 0.25 * WGS84_SEMI_MAJOR_AXIS + distance,
  );
  const projectionMat = mat4.perspective(
    mat4.create(),
    GLOBE_FIELD_OF_VIEW,
    width / Math.max(1, height),
    near,
    far,
  );
  return { target, eye, invViewMatrix, projectionMat, near, far };
}

/**
 * Returns the angle subtended by one pixel at the center of the view of the globe camera.
 */
export function getGlobePixelAngle(height: number) {
  return GLOBE_FIELD_OF_VIEW / Math.max(1, height);
}

/**
 * Generates the vertices of the ellipsoid as a latitude/longitude grid, in ECEF coordinates split
 * into high and low parts, with the geodetic coordinates of each vertex.  The grid has duplicate
 * vertices at the antimeridian such that longitudes are continuous within each triangle.
 */
export function makeEllipsoidMesh(numLon: number, numLat: number) {
  const numVertices = (numLon + 1) * (numLat + 1);
  const ecef = new Float64Array(numVertices * 3);
  const lonLat = new Float32Array(numVertices * 2);
  let v = 0;
  for (let j = 0; j <= numLat; ++j) {
    const lat = -90 + (180 * j) / numLat;
    for (let i = 0; i <= numLon; ++i) {
      const lon = -180 + (360 * i) / numLon;
      geodeticToEcef(lon, lat, 0, ecef, 3 * v);
      lonLat[2 * v] = lon;
      lonLat[2 * v + 1] = lat;
      ++v;
    }
  }
  const indices = new Uint32Array(numLon * numLat * 6);
  let k = 0;
  for (let j = 0; j < numLat; ++j) {
    for (let i = 0; i < numLon; ++i) {
      const a = j * (numLon + 1) + i;
      const b = a + 1;
      const c = a + numLon + 1;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  const high = new Float32Array(numVertices * 3);
  const low = new Float32Array(numVertices * 3);
  splitDouble(ecef, high, low);
  return { high, low, lonLat, indices, numVertices };
}
