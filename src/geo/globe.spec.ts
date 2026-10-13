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
  computeGlobeCamera,
  ecefToGeodetic,
  geodeticToEcef,
  getGlobeCameraRay,
  getGlobeRotationBetween,
  getNorthUpGlobeOrientation,
  GLOBE_MAX_CAMERA_DISTANCE,
  intersectGlobeRay,
  makeEllipsoidMesh,
  rotateGlobeCamera,
  splitDouble,
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_SEMI_MINOR_AXIS,
} from "#src/geo/globe.js";
import { mat4, quat, vec3 } from "#src/util/geom.js";

describe("globe geometry", () => {
  it("converts between geodetic and ECEF coordinates", () => {
    const equator = geodeticToEcef(0, 0, 0, new Float64Array(3));
    expect(Array.from(equator)).toEqual([WGS84_SEMI_MAJOR_AXIS, 0, 0]);
    const pole = geodeticToEcef(0, 90, 0, new Float64Array(3));
    expect(pole[2]).toBeCloseTo(WGS84_SEMI_MINOR_AXIS, 6);
    for (const [lon, lat, h] of [
      [-178, -20, -600000],
      [142, 38, 3776],
      [13.4, 52.5, 0],
      [-45, 89.9, 1000],
    ]) {
      const p = geodeticToEcef(lon, lat, h, new Float64Array(3));
      const g = ecefToGeodetic(p[0], p[1], p[2], new Float64Array(3));
      expect(g[0]).toBeCloseTo(lon, 9);
      expect(g[1]).toBeCloseTo(lat, 9);
      expect(g[2]).toBeCloseTo(h, 3);
    }
    // High/low split.
    const high = new Float32Array(3);
    const low = new Float32Array(3);
    splitDouble(Float64Array.of(6378137.123456, -1.5, 1e-9), high, low);
    expect(high[0] + low[0]).toBeCloseTo(6378137.123456, 5);
  });

  it("computes an orbit camera looking at the target", () => {
    const width = 800;
    const height = 600;
    for (const [lon, lat, distance] of [
      [0, 0, 1e7],
      [-178, -20, 5000],
      [142, 38, 2e5],
    ]) {
      const camera = computeGlobeCamera({
        lon,
        lat,
        distance,
        orientation: quat.create(),
        width,
        height,
      });
      // With the identity orientation, the camera is straight above the target.
      const up = geodeticToEcef(lon, lat, distance, new Float64Array(3));
      for (let i = 0; i < 3; ++i) {
        expect(camera.eye[i]).toBeCloseTo(up[i], 0);
      }
      // The target (origin of render coordinates) projects to the center of the view, in front of
      // the near plane.
      const viewMatrix = mat4.invert(mat4.create(), camera.invViewMatrix)!;
      const viewProjection = mat4.multiply(
        mat4.create(),
        camera.projectionMat,
        viewMatrix,
      );
      const clip = vec3.transformMat4(
        vec3.create(),
        vec3.create(),
        viewProjection,
      );
      expect(clip[0]).toBeCloseTo(0, 5);
      expect(clip[1]).toBeCloseTo(0, 5);
      expect(Math.abs(clip[2])).toBeLessThan(1);
      // North is up on the screen.
      const north = geodeticToEcef(lon, lat + 1e-3, 0, new Float64Array(3));
      const northRender = vec3.fromValues(
        north[0] - camera.target[0],
        north[1] - camera.target[1],
        north[2] - camera.target[2],
      );
      const northClip = vec3.transformMat4(
        vec3.create(),
        northRender,
        viewProjection,
      );
      expect(northClip[1]).toBeGreaterThan(0);
      expect(Math.abs(northClip[0])).toBeLessThan(1e-3);
    }
    // The distance is clamped.
    const far = computeGlobeCamera({
      lon: 0,
      lat: 0,
      distance: 1e12,
      orientation: quat.create(),
      width,
      height,
    });
    expect(far.eye[0]).toBeCloseTo(
      WGS84_SEMI_MAJOR_AXIS + GLOBE_MAX_CAMERA_DISTANCE,
      0,
    );
  });

  it("generates the ellipsoid mesh", () => {
    const mesh = makeEllipsoidMesh(8, 4);
    expect(mesh.numVertices).toBe(9 * 5);
    expect(mesh.indices.length).toBe(8 * 4 * 6);
    expect(Math.max(...mesh.indices)).toBe(mesh.numVertices - 1);
  });

  it("pans the camera rigidly, also across the poles", () => {
    const a = WGS84_SEMI_MAJOR_AXIS;
    // Rays that hit the ellipsoid, and that miss it (closest silhouette point).
    const hit = intersectGlobeRay([2 * a, 0, 0], [-1, 0, 0]);
    expect(hit.hit).toBe(true);
    expect(hit.point[0]).toBeCloseTo(a, 3);
    const pole = intersectGlobeRay([0, 0, 2 * a], [0, 0, -1]);
    expect(pole.point[2]).toBeCloseTo(WGS84_SEMI_MINOR_AXIS, 3);
    const miss = intersectGlobeRay([2 * a, 0, 0], [0, 1, 0]);
    expect(miss.hit).toBe(false);
    expect(Array.from(miss.point).map((v) => v / a)).toEqual([1, 0, 0]);

    // The ray through the center of the view hits the target.
    const camera = computeGlobeCamera({
      lon: 20,
      lat: 40,
      distance: 1e6,
      orientation: quat.setAxisAngle(quat.create(), [1, 0, 0], 0.5),
      width: 800,
      height: 600,
    });
    const ray = getGlobeCameraRay(camera, 0, 0, 800 / 600);
    const center = intersectGlobeRay(ray.origin, ray.direction).point;
    for (let i = 0; i < 3; ++i) {
      expect(center[i]).toBeCloseTo(camera.target[i], 0);
    }

    // Rotations map directions, and are limited to below a half turn.
    const r = getGlobeRotationBetween([1, 0, 0], [0, 2, 0]);
    expect(Array.from(r.subarray(0, 3)).map((v) => +v.toFixed(12))).toEqual([
      0, 1, 0,
    ]);
    const half = getGlobeRotationBetween([1, 0, 0], [-1, 1e-9, 0]);
    expect(half[0]).toBeGreaterThan(-1);

    // Panning over the north pole: from 85N on the 0 meridian to 85N on the 180 meridian.  The
    // camera axes rotate with the globe, so the heading flips while the tilt is unchanged.
    const orientation = quat.setAxisAngle(quat.create(), [1, 0, 0], 0.4);
    const from = geodeticToEcef(0, 85, 0, new Float64Array(3));
    const to = geodeticToEcef(180, 85, 0, new Float64Array(3));
    const rotation = getGlobeRotationBetween(from, to);
    const result = rotateGlobeCamera(0, 85, orientation, rotation);
    expect(Math.abs(result.lon)).toBeCloseTo(180, 6);
    expect(result.lat).toBeCloseTo(85, 6);
    const before = computeGlobeCamera({
      lon: 0,
      lat: 85,
      distance: 1e6,
      orientation,
      width: 800,
      height: 600,
    });
    const after = computeGlobeCamera({
      lon: result.lon,
      lat: result.lat,
      distance: 1e6,
      orientation: result.orientation,
      width: 800,
      height: 600,
    });
    for (let col = 0; col < 3; ++col) {
      for (let i = 0; i < 3; ++i) {
        let rotated = 0;
        for (let k = 0; k < 3; ++k) {
          rotated += rotation[3 * k + i] * before.invViewMatrix[4 * col + k];
        }
        expect(after.invViewMatrix[4 * col + i]).toBeCloseTo(rotated, 6);
      }
    }
    // Resetting north keeps the tilt.
    const back = (q: quat) => vec3.transformQuat(vec3.create(), [0, 0, 1], q);
    const northUp = getNorthUpGlobeOrientation(result.orientation);
    expect(back(northUp)[2]).toBeCloseTo(back(result.orientation)[2], 9);
    expect(back(northUp)[0]).toBeCloseTo(0, 9);
    expect(back(northUp)[1]).toBeLessThan(0);
  });
});
