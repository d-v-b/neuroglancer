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

import { mat3, mat4, quat, vec3 } from "#src/util/geom.js";

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
 * Generates the vertices of the ellipsoid (or of a surface at a constant height above it) as a
 * latitude/longitude grid, in ECEF coordinates split into high and low parts, with the geodetic
 * coordinates of each vertex.  The grid has duplicate vertices at the antimeridian such that
 * longitudes are continuous within each triangle.
 */
export function makeEllipsoidMesh(numLon: number, numLat: number, height = 0) {
  const numVertices = (numLon + 1) * (numLat + 1);
  const ecef = new Float64Array(numVertices * 3);
  const lonLat = new Float32Array(numVertices * 2);
  let v = 0;
  for (let j = 0; j <= numLat; ++j) {
    const lat = -90 + (180 * j) / numLat;
    for (let i = 0; i <= numLon; ++i) {
      const lon = -180 + (360 * i) / numLon;
      geodeticToEcef(lon, lat, height, ecef, 3 * v);
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

/**
 * Returns the ray from the camera through a point of the view, given in normalized device
 * coordinates (`[-1, 1]`, with y up), in ECEF coordinates.  `aspect` is the width of the view
 * divided by its height.
 */
export function getGlobeCameraRay(
  camera: GlobeCamera,
  ndcX: number,
  ndcY: number,
  aspect: number,
) {
  const m = camera.invViewMatrix;
  const t = Math.tan(GLOBE_FIELD_OF_VIEW / 2);
  const x = ndcX * t * aspect;
  const y = ndcY * t;
  const direction = new Float64Array(3);
  for (let i = 0; i < 3; ++i) {
    direction[i] = m[i] * x + m[4 + i] * y - m[8 + i];
  }
  return { origin: Float64Array.from(camera.eye), direction };
}

/**
 * Returns the first intersection of a ray with the ellipsoid.  If the ray misses the ellipsoid,
 * returns the point of the silhouette of the ellipsoid closest to the ray instead, such that the
 * result varies continuously as the ray crosses the silhouette.
 */
export function intersectGlobeRay(
  origin: ArrayLike<number>,
  direction: ArrayLike<number>,
): { point: Float64Array; hit: boolean } {
  // Scale z such that the ellipsoid becomes a sphere of radius `a`.
  const a = WGS84_SEMI_MAJOR_AXIS;
  const s = a / WGS84_SEMI_MINOR_AXIS;
  const o = [origin[0], origin[1], origin[2] * s];
  const d = [direction[0], direction[1], direction[2] * s];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const od = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const oo = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
  const discriminant = od * od - dd * (oo - a * a);
  const point = new Float64Array(3);
  let hit = false;
  let t: number;
  if (discriminant >= 0 && (t = (-od - Math.sqrt(discriminant)) / dd) >= 0) {
    hit = true;
    for (let i = 0; i < 3; ++i) point[i] = o[i] + t * d[i];
  } else {
    // Closest point of the ray to the center, projected onto the sphere.
    t = Math.max(0, -od / dd);
    for (let i = 0; i < 3; ++i) point[i] = o[i] + t * d[i];
    const r = Math.hypot(point[0], point[1], point[2]);
    for (let i = 0; i < 3; ++i) point[i] *= a / r;
  }
  point[2] /= s;
  return { point, hit };
}

/**
 * Maximum angle of the rotation between two points of the globe (just below a half turn, such that
 * the rotation axis remains well defined).
 */
const MAX_GLOBE_ROTATION_ANGLE = 0.98 * Math.PI;

/**
 * Returns the rotation (as a column-major 3x3 matrix) about the center of the Earth that maps the
 * direction of `from` to the direction of `to`, with the angle limited to just below a half turn.
 */
export function getGlobeRotationBetween(
  from: ArrayLike<number>,
  to: ArrayLike<number>,
): Float64Array {
  const fr = Math.hypot(from[0], from[1], from[2]);
  const tr = Math.hypot(to[0], to[1], to[2]);
  const f = [from[0] / fr, from[1] / fr, from[2] / fr];
  const g = [to[0] / tr, to[1] / tr, to[2] / tr];
  const axis = [
    f[1] * g[2] - f[2] * g[1],
    f[2] * g[0] - f[0] * g[2],
    f[0] * g[1] - f[1] * g[0],
  ];
  const sinAngle = Math.hypot(axis[0], axis[1], axis[2]);
  const cosAngle = f[0] * g[0] + f[1] * g[1] + f[2] * g[2];
  const result = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  if (sinAngle < 1e-15) return result;
  const angle = Math.min(
    MAX_GLOBE_ROTATION_ANGLE,
    Math.atan2(sinAngle, cosAngle),
  );
  const [x, y, z] = axis.map((v) => v / sinAngle);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const C = 1 - c;
  // Rodrigues' rotation formula, column-major.
  result.set([
    c + x * x * C,
    y * x * C + z * s,
    z * x * C - y * s,
    x * y * C - z * s,
    c + y * y * C,
    z * y * C + x * s,
    x * z * C + y * s,
    y * z * C - x * s,
    c + z * z * C,
  ]);
  return result;
}

/**
 * Applies a rotation about the center of the Earth to the camera of the globe view: the target
 * moves with the rotation, and the camera orientation (relative to the east-north-up frame of the
 * target) is carried along, such that the view moves rigidly with the rotation.  Unlike changes of
 * latitude and longitude, this has no singularities at the poles.
 *
 * @param rotation Column-major 3x3 rotation matrix.
 */
export function rotateGlobeCamera(
  lon: number,
  lat: number,
  orientation: quat,
  rotation: ArrayLike<number>,
): { lon: number; lat: number; orientation: quat } {
  const target = geodeticToEcef(lon, lat, 0, new Float64Array(3));
  const r = rotation;
  const rotated = [0, 1, 2].map(
    (i) => r[i] * target[0] + r[3 + i] * target[1] + r[6 + i] * target[2],
  );
  const geodetic = ecefToGeodetic(
    rotated[0],
    rotated[1],
    rotated[2],
    new Float64Array(3),
  );
  const enu = getEnuBasis(lon, lat);
  const newEnu = getEnuBasis(geodetic[0], geodetic[1]);
  // Camera axes relative to the east-north-up frame.
  const axes = mat3.fromQuat(mat3.create(), orientation);
  const newAxes = mat3.create();
  for (let col = 0; col < 3; ++col) {
    // Camera axis in ECEF, rotated.
    const world = [0, 1, 2].map(
      (i) =>
        enu[i] * axes[3 * col] +
        enu[3 + i] * axes[3 * col + 1] +
        enu[6 + i] * axes[3 * col + 2],
    );
    const rotatedWorld = [0, 1, 2].map(
      (i) => r[i] * world[0] + r[3 + i] * world[1] + r[6 + i] * world[2],
    );
    // Relative to the new east-north-up frame.
    for (let k = 0; k < 3; ++k) {
      newAxes[3 * col + k] =
        newEnu[3 * k] * rotatedWorld[0] +
        newEnu[3 * k + 1] * rotatedWorld[1] +
        newEnu[3 * k + 2] * rotatedWorld[2];
    }
  }
  const newOrientation = quatFromMat3(newAxes);
  return { lon: geodetic[0], lat: geodetic[1], orientation: newOrientation };
}

function quatFromMat3(m: mat3): quat {
  const q = quat.fromMat3(quat.create(), m);
  return quat.normalize(q, q);
}

/**
 * Returns the orientation with the same tilt as `orientation` (angle between the viewing direction
 * and the vertical), looking north.
 */
export function getNorthUpGlobeOrientation(orientation: quat): quat {
  const back = vec3.transformQuat(
    vec3.create(),
    vec3.fromValues(0, 0, 1),
    orientation,
  );
  const tilt = Math.acos(Math.max(-1, Math.min(1, back[2])));
  return quat.setAxisAngle(quat.create(), vec3.fromValues(1, 0, 0), tilt);
}
