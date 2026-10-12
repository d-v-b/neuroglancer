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
 * @file Point transformations between coordinate reference systems.
 */

import proj4 from "proj4";
import type { Crs } from "#src/geo/crs.js";
import { WGS84_GEOGRAPHIC_DEFINITION } from "#src/geo/crs.js";

/**
 * Result status of a point transformation.
 */
export enum TransformStatus {
  /** The point could not be transformed. */
  INVALID = 0,
  /** The point was transformed exactly. */
  VALID = 1,
  /**
   * The point lies outside the domain of the target CRS (e.g. beyond the latitude limit of Web
   * Mercator) and was clamped to its boundary.
   */
  CLAMPED = 2,
}

type PointFn = (coords: number[]) => number[];

/**
 * Latitudes up to this absolute value are clamped to the poles rather than treated as invalid.
 */
const MAX_LATITUDE_OVERSHOOT = 95;

const MAX_CYLINDRICAL_LATITUDE = 90 - 1e-9;

function makeConverter(
  from: string,
  to: string,
): { forward: PointFn; inverse: PointFn } {
  const c = proj4(from, to);
  return {
    forward: (p) => c.forward(p),
    inverse: (p) => c.inverse(p),
  };
}

function wrapLongitude(lon: number, reference: number) {
  const d = lon - reference;
  if (d > 180 + 1e-9 || d < -180 - 1e-9) {
    return lon - 360 * Math.round(d / 360);
  }
  return lon;
}

/**
 * Transformation between geographic WGS84 coordinates and a CRS.
 */
export class GeographicTransform {
  private toGeographic: PointFn | undefined;
  private fromGeographic: PointFn | undefined;
  private clampLatitude: number;
  private temp = [0, 0];

  private isCylindricalProjected: boolean;

  /**
   * For projected cylindrical CRSs, the period in x corresponding to 360 degrees of longitude, and
   * the x coordinate of the central meridian.  Longitude is then a linear function of x, which is
   * used to unwrap longitudes continuously (also for CRSs specified as WKT, for which proj4 wraps
   * longitudes into [-180, 180]).
   */
  private cylindricalPeriod: number | undefined;
  private cylindricalCenterX = 0;

  /**
   * For projected cylindrical CRSs that can represent the poles, the y coordinate of the equator
   * and the displacement in y from the equator to the north pole.  Proj4 folds latitudes of points
   * beyond the poles (e.g. -89.9 instead of 90.1), and such points are instead clamped to the
   * poles.
   */
  private cylindricalEquatorY = 0;
  private cylindricalPoleOffsetY: number | undefined;

  /**
   * @param crs Target CRS.
   * @param referenceLongitude Longitudes computed by `toGeographic` are unwrapped to lie within 180
   *     degrees of this reference longitude.  If `undefined`, longitudes are returned as computed by
   *     proj4.  Ignored for geographic and cylindrical CRSs, whose longitudes are unwrapped
   *     continuously.
   */
  constructor(
    public crs: Crs,
    public referenceLongitude: number | undefined = undefined,
  ) {
    const isWgs84Geographic =
      crs.isGeographic &&
      (crs.definition === WGS84_GEOGRAPHIC_DEFINITION ||
        /\+datum=WGS84\b/.test(crs.definition));
    if (!isWgs84Geographic) {
      const c = makeConverter(
        WGS84_GEOGRAPHIC_DEFINITION,
        crs.unwrappedDefinition,
      );
      this.toGeographic = c.inverse;
      this.fromGeographic = c.forward;
    }
    this.clampLatitude = crs.maxLatitude;
    const { worldPeriod } = crs;
    this.isCylindricalProjected =
      worldPeriod !== undefined && !crs.isGeographic;
    if (this.isCylindricalProjected) {
      const out = [0, 0];
      if (
        this.fromLonLat(crs.centralMeridian, 0, out) === TransformStatus.VALID
      ) {
        this.cylindricalPeriod = worldPeriod;
        this.cylindricalCenterX = out[0];
        this.cylindricalEquatorY = out[1];
        if (
          crs.maxLatitude === 90 &&
          this.fromLonLat(crs.centralMeridian, 90, out) ===
            TransformStatus.VALID
        ) {
          const offset = out[1] - this.cylindricalEquatorY;
          if (
            this.fromLonLat(crs.centralMeridian, 45, out) ===
              TransformStatus.VALID &&
            (out[1] - this.cylindricalEquatorY) / offset > 0
          ) {
            this.cylindricalPoleOffsetY = offset;
          }
        }
      }
    }
  }

  private getLinearLongitude(x: number) {
    return (
      this.crs.centralMeridian +
      (360 * (x - this.cylindricalCenterX)) / this.cylindricalPeriod!
    );
  }

  /**
   * Transforms CRS coordinates to geographic (longitude, latitude) coordinates in degrees.
   */
  toLonLat(
    x: number,
    y: number,
    out: Float64Array | number[],
  ): TransformStatus {
    let lon: number;
    let lat: number;
    const { toGeographic, cylindricalPoleOffsetY } = this;
    const v =
      cylindricalPoleOffsetY === undefined
        ? 0
        : (y - this.cylindricalEquatorY) / cylindricalPoleOffsetY;
    if (Math.abs(v) > 1) {
      // Beyond a pole of a cylindrical CRS.  The overshoot is approximated linearly in y (exact for
      // equirectangular projections).
      if (90 * Math.abs(v) > MAX_LATITUDE_OVERSHOOT) {
        return TransformStatus.INVALID;
      }
      out[0] = this.getLinearLongitude(x);
      out[1] = Math.sign(v) * 90;
      return TransformStatus.VALID;
    }
    if (toGeographic === undefined) {
      lon = x;
      lat = y;
    } else {
      const temp = this.temp;
      temp[0] = x;
      temp[1] = y;
      let r: number[];
      try {
        r = toGeographic(temp);
      } catch {
        return TransformStatus.INVALID;
      }
      lon = r[0];
      lat = r[1];
    }
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > MAX_LATITUDE_OVERSHOOT
    ) {
      return TransformStatus.INVALID;
    }
    // Coordinates slightly beyond the poles arise for cell edges of grids whose cell centers lie on
    // the poles.
    lat = Math.max(-90, Math.min(90, lat));
    const { cylindricalPeriod } = this;
    if (cylindricalPeriod !== undefined) {
      // Longitude is determined by x, such that sources extending (slightly) beyond 360 degrees of
      // longitude, e.g. grids whose cell centers lie on the antimeridian, are not folded.
      lon += 360 * Math.round((this.getLinearLongitude(x) - lon) / 360);
    } else {
      const { referenceLongitude } = this;
      if (referenceLongitude !== undefined && !this.crs.isGeographic) {
        lon = wrapLongitude(lon, referenceLongitude);
      }
    }
    out[0] = lon;
    out[1] = lat;
    return TransformStatus.VALID;
  }

  /**
   * Transforms geographic coordinates to CRS coordinates.
   */
  fromLonLat(
    lon: number,
    lat: number,
    out: Float64Array | number[],
  ): TransformStatus {
    let status = TransformStatus.VALID;
    const maxLat = this.clampLatitude;
    if (lat > maxLat) {
      lat = maxLat;
      status = TransformStatus.CLAMPED;
    } else if (lat < -maxLat) {
      lat = -maxLat;
      status = TransformStatus.CLAMPED;
    }
    const { fromGeographic } = this;
    if (fromGeographic === undefined) {
      out[0] = lon;
      out[1] = lat;
      return status;
    }
    if (this.isCylindricalProjected) {
      // Proj4 folds latitudes of exactly +/-90 degrees in some cylindrical projections (e.g. eqc),
      // due to rounding.
      lat = Math.max(
        -MAX_CYLINDRICAL_LATITUDE,
        Math.min(MAX_CYLINDRICAL_LATITUDE, lat),
      );
    }
    const temp = this.temp;
    temp[0] = lon;
    temp[1] = lat;
    let r: number[];
    try {
      r = fromGeographic(temp);
    } catch {
      return TransformStatus.INVALID;
    }
    let x = r[0];
    const y = r[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return TransformStatus.INVALID;
    }
    const { cylindricalPeriod } = this;
    if (cylindricalPeriod !== undefined) {
      const linearX =
        this.cylindricalCenterX +
        (cylindricalPeriod * (lon - this.crs.centralMeridian)) / 360;
      x += cylindricalPeriod * Math.round((linearX - x) / cylindricalPeriod);
    }
    out[0] = x;
    out[1] = y;
    return status;
  }
}

/**
 * Transformation from a source CRS to a target CRS.
 *
 * The forward transformation unwraps longitudes relative to `referenceLongitude` (or, for
 * geographic and cylindrical source CRSs, continuously), such that a source dataset spanning the
 * antimeridian maps to a contiguous region in a cylindrical target CRS.
 */
export class CrsTransform {
  readonly isIdentity: boolean;
  private source: GeographicTransform;
  private target: GeographicTransform;
  private temp = new Float64Array(2);

  constructor(
    public sourceCrs: Crs,
    public targetCrs: Crs,
    referenceLongitude: number | undefined = undefined,
  ) {
    this.isIdentity = sourceCrs.definition === targetCrs.definition;
    this.source = new GeographicTransform(sourceCrs, referenceLongitude);
    this.target = new GeographicTransform(targetCrs, undefined);
  }

  forward(x: number, y: number, out: Float64Array | number[]): TransformStatus {
    if (this.isIdentity) {
      out[0] = x;
      out[1] = y;
      return TransformStatus.VALID;
    }
    const temp = this.temp;
    if (this.source.toLonLat(x, y, temp) === TransformStatus.INVALID) {
      return TransformStatus.INVALID;
    }
    return this.target.fromLonLat(temp[0], temp[1], out);
  }

  inverse(x: number, y: number, out: Float64Array | number[]): TransformStatus {
    if (this.isIdentity) {
      out[0] = x;
      out[1] = y;
      return TransformStatus.VALID;
    }
    const temp = this.temp;
    if (this.target.toLonLat(x, y, temp) === TransformStatus.INVALID) {
      return TransformStatus.INVALID;
    }
    return this.source.fromLonLat(temp[0], temp[1], out);
  }
}

const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Great-circle distance in meters between two geographic points (degrees), using the mean Earth
 * radius.
 */
export function haversineDistance(
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
) {
  const toRad = Math.PI / 180;
  const phi0 = lat0 * toRad;
  const phi1 = lat1 * toRad;
  const dPhi = phi1 - phi0;
  const dLambda = (lon1 - lon0) * toRad;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi0) * Math.cos(phi1) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}
