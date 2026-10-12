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
 * @file Interpretation of GeoTIFF georeferencing tags.
 *
 * See the OGC GeoTIFF standard: http://docs.opengeospatial.org/is/19-008r4/19-008r4.html
 */

import type { TiffImage, TiffTagValue } from "#src/datasource/geotiff/tiff.js";
import { TiffTag } from "#src/datasource/geotiff/tiff.js";
import { getEpsgDefinition } from "#src/geo/crs.js";
import type { Affine2d } from "#src/geo/source_warp.js";

export enum GeoKey {
  GTModelType = 1024,
  GTRasterType = 1025,
  GTCitation = 1026,
  GeographicType = 2048,
  GeogCitation = 2049,
  GeogGeodeticDatum = 2050,
  GeogPrimeMeridian = 2051,
  GeogLinearUnits = 2052,
  GeogAngularUnits = 2054,
  GeogEllipsoid = 2056,
  GeogSemiMajorAxis = 2057,
  GeogSemiMinorAxis = 2058,
  GeogInvFlattening = 2059,
  ProjectedCSType = 3072,
  PCSCitation = 3073,
  Projection = 3074,
  ProjCoordTrans = 3075,
  ProjLinearUnits = 3076,
  ProjStdParallel1 = 3078,
  ProjStdParallel2 = 3079,
  ProjNatOriginLong = 3080,
  ProjNatOriginLat = 3081,
  ProjFalseEasting = 3082,
  ProjFalseNorthing = 3083,
  ProjFalseOriginLong = 3084,
  ProjFalseOriginLat = 3085,
  ProjFalseOriginEasting = 3086,
  ProjFalseOriginNorthing = 3087,
  ProjCenterLong = 3088,
  ProjCenterLat = 3089,
  ProjScaleAtNatOrigin = 3092,
  ProjScaleAtCenter = 3093,
  ProjAzimuthAngle = 3094,
  ProjStraightVertPoleLong = 3095,
}

const USER_DEFINED = 32767;

export type GeoKeyValue = number | number[] | string;

/**
 * Parses the GeoKeyDirectory.  Returns `undefined` if the image has no GeoKeyDirectory.
 */
export function parseGeoKeys(
  tags: Map<number, TiffTagValue>,
): Map<number, GeoKeyValue> | undefined {
  const directory = tags.get(TiffTag.GeoKeyDirectory);
  if (!Array.isArray(directory)) return undefined;
  const doubles = tags.get(TiffTag.GeoDoubleParams);
  const ascii = tags.get(TiffTag.GeoAsciiParams);
  const numKeys = directory[3];
  const keys = new Map<number, GeoKeyValue>();
  for (let i = 0; i < numKeys; ++i) {
    const base = 4 + 4 * i;
    if (base + 3 >= directory.length) break;
    const keyId = directory[base];
    const location = directory[base + 1];
    const count = directory[base + 2];
    const valueOffset = directory[base + 3];
    let value: GeoKeyValue | undefined;
    if (location === 0) {
      value = valueOffset;
    } else if (location === TiffTag.GeoDoubleParams) {
      if (Array.isArray(doubles)) {
        const values = doubles.slice(valueOffset, valueOffset + count);
        value = count === 1 ? values[0] : values;
      }
    } else if (location === TiffTag.GeoAsciiParams) {
      if (typeof ascii === "string") {
        value = ascii
          .substring(valueOffset, valueOffset + count)
          .replace(/[|\0]+$/, "");
      }
    } else if (location === TiffTag.GeoKeyDirectory) {
      const values = directory.slice(valueOffset, valueOffset + count);
      value = count === 1 ? values[0] : values;
    }
    if (value !== undefined) keys.set(keyId, value);
  }
  return keys;
}

function getNumberKey(keys: Map<number, GeoKeyValue>, key: GeoKey) {
  const value = keys.get(key);
  if (typeof value === "number") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function getDatumParameters(keys: Map<number, GeoKeyValue>): string {
  const geographicType = getNumberKey(keys, GeoKey.GeographicType);
  if (geographicType !== undefined && geographicType !== USER_DEFINED) {
    const def = getEpsgDefinition(geographicType);
    if (def !== undefined) {
      return def
        .split(/\s+/)
        .filter(
          (p) =>
            p.startsWith("+datum=") ||
            p.startsWith("+ellps=") ||
            p.startsWith("+towgs84=") ||
            p.startsWith("+a=") ||
            p.startsWith("+b="),
        )
        .join(" ");
    }
    if (geographicType === 4326) return "+datum=WGS84";
  }
  const a = getNumberKey(keys, GeoKey.GeogSemiMajorAxis);
  if (a !== undefined) {
    const invF = getNumberKey(keys, GeoKey.GeogInvFlattening);
    const b = getNumberKey(keys, GeoKey.GeogSemiMinorAxis);
    if (invF !== undefined && invF !== 0) return `+a=${a} +rf=${invF}`;
    if (b !== undefined) return `+a=${a} +b=${b}`;
    return `+a=${a} +b=${a}`;
  }
  return "+datum=WGS84";
}

const LINEAR_UNITS: Record<number, string> = {
  9001: "+units=m",
  9002: "+units=ft",
  9003: "+units=us-ft",
};

/**
 * Constructs a proj4 definition for a user-defined projected CRS.  Returns `undefined` if the
 * projection is not supported.
 */
function getUserDefinedProjection(
  keys: Map<number, GeoKeyValue>,
): string | undefined {
  const method = getNumberKey(keys, GeoKey.ProjCoordTrans);
  if (method === undefined) return undefined;
  const get = (key: GeoKey, defaultValue = 0) =>
    getNumberKey(keys, key) ?? defaultValue;
  const datum = getDatumParameters(keys);
  const units =
    LINEAR_UNITS[get(GeoKey.ProjLinearUnits, 9001)] ?? LINEAR_UNITS[9001];
  const falseEasting = get(
    GeoKey.ProjFalseEasting,
    get(GeoKey.ProjFalseOriginEasting),
  );
  const falseNorthing = get(
    GeoKey.ProjFalseNorthing,
    get(GeoKey.ProjFalseOriginNorthing),
  );
  const common = `+x_0=${falseEasting} +y_0=${falseNorthing} ${datum} ${units} +no_defs`;
  const lon0 = get(
    GeoKey.ProjNatOriginLong,
    get(GeoKey.ProjCenterLong, get(GeoKey.ProjFalseOriginLong)),
  );
  const lat0 = get(
    GeoKey.ProjNatOriginLat,
    get(GeoKey.ProjCenterLat, get(GeoKey.ProjFalseOriginLat)),
  );
  const k0 = get(GeoKey.ProjScaleAtNatOrigin, get(GeoKey.ProjScaleAtCenter, 1));
  const lat1 = get(GeoKey.ProjStdParallel1);
  const lat2 = get(GeoKey.ProjStdParallel2, lat1);
  switch (method) {
    case 1: // TransverseMercator
      return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=${k0} ${common}`;
    case 7: // Mercator
      return `+proj=merc +lon_0=${lon0} +k=${k0} ${common}`;
    case 8: // LambertConfConic_2SP
      return `+proj=lcc +lat_0=${lat0} +lon_0=${lon0} +lat_1=${lat1} +lat_2=${lat2} ${common}`;
    case 9: // LambertConfConic_1SP
      return `+proj=lcc +lat_0=${lat0} +lat_1=${lat0} +lon_0=${lon0} +k_0=${k0} ${common}`;
    case 10: // LambertAzimEqualArea
      return `+proj=laea +lat_0=${lat0} +lon_0=${lon0} ${common}`;
    case 11: // AlbersEqualArea
      return `+proj=aea +lat_0=${lat0} +lon_0=${lon0} +lat_1=${lat1} +lat_2=${lat2} ${common}`;
    case 15: {
      // PolarStereographic
      const poleLon = get(GeoKey.ProjStraightVertPoleLong, lon0);
      const latTs = lat0;
      return `+proj=stere +lat_0=${latTs >= 0 ? 90 : -90} +lat_ts=${latTs} +lon_0=${poleLon} +k=${k0} ${common}`;
    }
    case 16: // Oblique stereographic
      return `+proj=sterea +lat_0=${lat0} +lon_0=${lon0} +k=${k0} ${common}`;
    case 17: // Equirectangular
      return `+proj=eqc +lat_ts=${lat1} +lat_0=${lat0} +lon_0=${lon0} ${common}`;
    case 28: // Equidistant cylindrical (alternate code)
      return `+proj=eqc +lat_ts=${lat1} +lat_0=${lat0} +lon_0=${lon0} ${common}`;
    default:
      return undefined;
  }
}

export interface GeoTiffGeoreference {
  /**
   * CRS specification, or `undefined` if the CRS could not be determined.
   */
  crs: string | undefined;

  /**
   * Description of the CRS from the GeoTIFF citation keys, for error messages.
   */
  citation: string | undefined;

  /**
   * Transform from pixel coordinates (column, row), with pixel `(i, j)` covering
   * `[i, i+1) x [j, j+1)`, to CRS coordinates.
   */
  pixelToCrs: Affine2d;
}

/**
 * Determines the georeferencing of a GeoTIFF image.  Returns `undefined` if the image is not
 * georeferenced.
 */
export function getGeoTiffGeoreference(
  image: TiffImage,
): GeoTiffGeoreference | undefined {
  const { tags } = image;
  const keys = parseGeoKeys(tags) ?? new Map<number, GeoKeyValue>();
  let pixelToCrs: Affine2d | undefined;
  const transformation = tags.get(TiffTag.ModelTransformation);
  const scale = tags.get(TiffTag.ModelPixelScale);
  const tiepoint = tags.get(TiffTag.ModelTiepoint);
  if (Array.isArray(transformation) && transformation.length >= 16) {
    const m = transformation;
    pixelToCrs = [m[0], m[4], m[1], m[5], m[3], m[7]];
  } else if (
    Array.isArray(scale) &&
    scale.length >= 2 &&
    Array.isArray(tiepoint) &&
    tiepoint.length >= 6
  ) {
    const [i, j, , x, y] = tiepoint;
    const [sx, sy] = scale;
    pixelToCrs = [sx, 0, 0, -sy, x - i * sx, y + j * sy];
  }
  if (pixelToCrs === undefined) return undefined;
  if (getNumberKey(keys, GeoKey.GTRasterType) === 2) {
    // PixelIsPoint: the tie point refers to the center of the pixel.  Shift by half a pixel, as
    // GDAL does, such that pixel (i, j) covers [i, i+1) x [j, j+1).
    pixelToCrs[4] -= 0.5 * (pixelToCrs[0] + pixelToCrs[2]);
    pixelToCrs[5] -= 0.5 * (pixelToCrs[1] + pixelToCrs[3]);
  }
  const citation =
    (keys.get(GeoKey.PCSCitation) as string | undefined) ??
    (keys.get(GeoKey.GTCitation) as string | undefined) ??
    (keys.get(GeoKey.GeogCitation) as string | undefined);
  let crs: string | undefined;
  const modelType = getNumberKey(keys, GeoKey.GTModelType);
  const projected = getNumberKey(keys, GeoKey.ProjectedCSType);
  const geographic = getNumberKey(keys, GeoKey.GeographicType);
  if (
    projected !== undefined &&
    projected !== USER_DEFINED &&
    projected !== 0
  ) {
    crs = `EPSG:${projected}`;
  } else if (
    modelType === 2 ||
    (modelType === undefined && projected === undefined)
  ) {
    if (geographic !== undefined && geographic !== USER_DEFINED) {
      crs = `EPSG:${geographic}`;
    } else if (keys.size !== 0) {
      crs = `+proj=longlat ${getDatumParameters(keys)} +no_defs`;
    }
  } else if (modelType === 1) {
    crs = getUserDefinedProjection(keys);
  }
  return { crs, citation, pixelToCrs };
}
