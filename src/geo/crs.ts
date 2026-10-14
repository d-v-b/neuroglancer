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
 * @file Coordinate reference system (CRS) registry.
 *
 * CRS definitions are resolved to proj4 definitions.  Coordinates are always in "easting, northing"
 * (longitude, latitude) axis order, regardless of the axis order specified by the authority.
 */

import proj4 from "proj4";

interface Converter {
  forward(coordinates: number[]): number[];
  inverse(coordinates: number[]): number[];
}

/**
 * Proj4 definition of geographic WGS84 coordinates, used as the pivot for all transformations.
 */
export const WGS84_GEOGRAPHIC_DEFINITION =
  "+proj=longlat +datum=WGS84 +no_defs";

/**
 * Maximum latitude representable in (spherical) Web Mercator.
 */
export const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

/**
 * Projections for which projected x is a linear function of longitude (independent of latitude),
 * such that the projection can be continued periodically ("world copies") in x.
 */
const CYLINDRICAL_PROJECTIONS = new Set([
  "longlat",
  "merc",
  "eqc",
  "cea",
  "mill",
  "gall",
]);

/**
 * Definitions of commonly-used CRSs not built into proj4.  UTM zones are generated on demand by
 * `getEpsgDefinition`.
 */
const EPSG_DEFINITIONS: Record<number, string> = {
  // Geographic
  4326: "+proj=longlat +datum=WGS84 +no_defs",
  4258: "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs",
  4269: "+proj=longlat +datum=NAD83 +no_defs",
  4979: "+proj=longlat +datum=WGS84 +no_defs",
  // Global projected
  3857: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs",
  3395: "+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  4087: "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  32662:
    "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  6933: "+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  8857: "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  54030: "+proj=robin +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  54009: "+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  // Polar
  3413: "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  3995: "+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  3031: "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  3976: "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  6931: "+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  6932: "+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  // Regional
  3035: "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  3034: "+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  5070: "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs",
  2163: "+proj=laea +lat_0=45 +lon_0=-100 +x_0=0 +y_0=0 +a=6370997 +b=6370997 +units=m +no_defs",
  3577: "+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  2193: "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  27700:
    "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs",
  2154: "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  28992:
    "+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs",
  3067: "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  2056: "+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs",
  3112: "+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  3338: "+proj=aea +lat_0=50 +lon_0=-154 +lat_1=55 +lat_2=65 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs",
};

/**
 * Returns the proj4 definition for the specified EPSG code, or `undefined` if the code is not
 * known.
 */
export function getEpsgDefinition(code: number): string | undefined {
  const def = EPSG_DEFINITIONS[code];
  if (def !== undefined) return def;
  // WGS 84 / UTM zones.
  if (code >= 32601 && code <= 32660) {
    return `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`;
  }
  if (code >= 32701 && code <= 32760) {
    return `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`;
  }
  // ETRS89 / UTM zones.
  if (code >= 25828 && code <= 25838) {
    return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  }
  // NAD83 / UTM zones.
  if (code >= 26901 && code <= 26923) {
    return `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`;
  }
  // GDA2020 / MGA zones.
  if (code >= 7846 && code <= 7859) {
    return `+proj=utm +zone=${code - 7800} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  }
  return undefined;
}

const customDefinitions = new Map<string, string>();

/**
 * Registers a definition for a CRS identifier (e.g. `"EPSG:31468"`) not otherwise known.  The
 * definition may be a proj4 string or WKT.
 */
export function registerCrsDefinition(identifier: string, definition: string) {
  customDefinitions.set(normalizeCrsIdentifier(identifier), definition);
  crsCache.delete(normalizeCrsIdentifier(identifier));
}

function normalizeCrsIdentifier(identifier: string): string {
  const s = identifier.trim();
  let m = s.match(/^(?:EPSG|epsg):+(\d+)$/);
  if (m !== null) return `EPSG:${m[1]}`;
  m = s.match(/^urn:ogc:def:crs:EPSG:[^:]*:(\d+)$/i);
  if (m !== null) return `EPSG:${m[1]}`;
  m = s.match(/^https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/(\d+)$/i);
  if (m !== null) return `EPSG:${m[1]}`;
  if (
    /^(?:OGC:)?CRS:?84$/i.test(s) ||
    /^urn:ogc:def:crs:OGC:[^:]*:CRS84$/i.test(s) ||
    /^https?:\/\/www\.opengis\.net\/def\/crs\/OGC\/[^/]+\/CRS84$/i.test(s)
  ) {
    return "EPSG:4326";
  }
  return s;
}

export type CrsUnit = "m" | "deg" | "ft" | "us-ft";

/**
 * Resolved coordinate reference system.
 */
export class Crs {
  /**
   * Normalized identifier, e.g. `"EPSG:4326"`, or the full definition for CRSs specified directly by
   * a proj4 string or WKT.
   */
  readonly id: string;

  /**
   * Proj4 definition string (or WKT).
   */
  readonly definition: string;

  /**
   * Proj4 definition with wrapping of longitudes disabled (`+over`), if supported.
   */
  readonly unwrappedDefinition: string;

  /**
   * Human-readable name.
   */
  readonly name: string;

  /**
   * Proj4 projection name, e.g. `"longlat"`, `"merc"`, `"utm"`.
   */
  readonly projectionName: string;

  /**
   * Indicates that coordinates are geographic (longitude, latitude) in degrees.
   */
  readonly isGeographic: boolean;

  /**
   * Units of the coordinates.
   */
  readonly unit: CrsUnit;

  /**
   * Conversion factor from the CRS units to meters (for geographic CRSs, the length of one degree
   * of arc along the equator).
   */
  readonly metersPerUnit: number;

  /**
   * For cylindrical projections, the period in x corresponding to 360 degrees of longitude.
   */
  readonly worldPeriod: number | undefined;

  /**
   * Central meridian in degrees.
   */
  readonly centralMeridian: number;

  /**
   * Maximum absolute latitude (in degrees) that can be represented.
   */
  readonly maxLatitude: number;

  /**
   * Semi-major axis of the ellipsoid in meters.
   */
  readonly semiMajorAxis: number;

  /**
   * Region `[xMin, yMin, xMax, yMax]` (in CRS units) outside of which coordinates are not
   * meaningful for display, e.g. because they correspond to extreme distortion near a projection
   * singularity.  For projected CRSs, this extends half the circumference of the Earth from the
   * false origin (a full world period in x for cylindrical projections, to allow sources spanning
   * the antimeridian); for geographic CRSs, it covers latitudes within ±90° and longitudes within
   * ±540°.
   */
  readonly displayDomain: [number, number, number, number];

  /** @internal */
  readonly proj: Converter;

  constructor(id: string, definition: string) {
    this.id = id;
    this.definition = definition;
    let converter: Converter;
    try {
      converter = proj4(definition) as unknown as Converter;
    } catch (e) {
      throw new Error(
        `Invalid CRS definition for ${JSON.stringify(id)}: ${(e as Error).message}`,
      );
    }
    this.proj = converter;
    const oProj = (converter as any).oProj ?? converter;
    const projName: string = oProj.projName ?? "";
    this.projectionName = projName;
    this.isGeographic =
      projName === "longlat" ||
      projName === "identity" ||
      projName === "lonlat";
    this.name = oProj.title || oProj.name || id;
    const toMeter: number | undefined = oProj.to_meter;
    const units: string | undefined = oProj.units;
    const a: number = oProj.a ?? 6378137;
    this.semiMajorAxis = a;
    if (this.isGeographic) {
      this.unit = "deg";
      this.metersPerUnit = (Math.PI / 180) * a;
    } else if (units === "ft") {
      this.unit = "ft";
      this.metersPerUnit = 0.3048;
    } else if (units === "us-ft") {
      this.unit = "us-ft";
      this.metersPerUnit = 1200 / 3937;
    } else {
      this.unit = "m";
      this.metersPerUnit = toMeter ?? 1;
    }
    const long0: number = oProj.long0 ?? 0;
    this.centralMeridian = (long0 * 180) / Math.PI;
    this.maxLatitude = projName === "merc" ? WEB_MERCATOR_MAX_LATITUDE : 90;
    const isCylindrical = CYLINDRICAL_PROJECTIONS.has(projName);
    if (isCylindrical && !this.isGeographic && typeof definition === "string") {
      this.unwrappedDefinition = definition.trim().startsWith("+")
        ? `${definition} +over`
        : definition;
    } else {
      this.unwrappedDefinition = definition;
    }
    if (this.isGeographic) {
      this.worldPeriod = 360;
    } else if (isCylindrical) {
      const p = proj4(WGS84_GEOGRAPHIC_DEFINITION, this.unwrappedDefinition);
      const lon0 = this.centralMeridian;
      const x0 = p.forward([lon0 - 90, 0])[0];
      const x1 = p.forward([lon0 + 90, 0])[0];
      const period = 2 * (x1 - x0);
      this.worldPeriod =
        Number.isFinite(period) && period > 0 ? period : undefined;
    } else {
      this.worldPeriod = undefined;
    }
    if (this.isGeographic) {
      this.displayDomain = [-540, -90, 540, 90];
    } else {
      const halfHeight = (Math.PI * a) / this.metersPerUnit;
      const halfWidth = this.worldPeriod ?? halfHeight;
      const x0: number = (oProj.x0 ?? 0) / this.metersPerUnit;
      const y0: number = (oProj.y0 ?? 0) / this.metersPerUnit;
      this.displayDomain = [
        x0 - halfWidth,
        y0 - halfHeight,
        x0 + halfWidth,
        y0 + halfHeight,
      ];
    }
  }

  toJSON() {
    return this.id;
  }
}

/**
 * Indicates whether `crs` can be used as the display CRS, which requires units of meters or
 * degrees.
 */
export function isDisplayCrsUnitSupported(crs: Crs): boolean {
  return crs.unit === "m" || crs.unit === "deg";
}

const crsCache = new Map<string, Crs>();

/**
 * Resolves a CRS specification.
 *
 * Supported forms:
 *   - `"EPSG:<code>"` (also URN and OGC URL forms) for built-in or registered codes;
 *   - `"OGC:CRS84"`;
 *   - a proj4 string, e.g. `"+proj=utm +zone=33 +datum=WGS84"`;
 *   - WKT.
 *
 * @throws Error if the CRS is not supported.
 */
export function getCrs(specification: string): Crs {
  const id = normalizeCrsIdentifier(specification);
  let crs = crsCache.get(id);
  if (crs !== undefined) return crs;
  let definition: string | undefined = customDefinitions.get(id);
  if (definition === undefined) {
    const m = id.match(/^EPSG:(\d+)$/);
    if (m !== null) {
      definition = getEpsgDefinition(parseInt(m[1], 10));
      if (definition === undefined) {
        throw new Error(
          `Unsupported CRS ${id}: specify a proj4 definition instead (e.g. "+proj=...")`,
        );
      }
    } else if (
      id.startsWith("+") ||
      /^(?:GEOG|PROJ|GEOD|COMPD|BOUND|ENGC|VERT|GEOC|LOCAL)[A-Z]*(?:CS|CRS)?\s*\[/i.test(
        id,
      )
    ) {
      definition = id;
    } else {
      throw new Error(`Unsupported CRS specification: ${JSON.stringify(id)}`);
    }
  }
  crs = new Crs(id, definition);
  crsCache.set(id, crs);
  return crs;
}

/**
 * Returns the CRS for the specified EPSG code.
 */
export function getEpsgCrs(code: number): Crs {
  return getCrs(`EPSG:${code}`);
}

export function tryGetCrs(specification: string): Crs | undefined {
  try {
    return getCrs(specification);
  } catch {
    return undefined;
  }
}

/**
 * List of CRSs offered in the user interface.
 */
export const COMMON_DISPLAY_CRS_LIST: { id: string; description: string }[] = [
  { id: "EPSG:4326", description: "WGS 84 (longitude/latitude)" },
  { id: "EPSG:3857", description: "WGS 84 / Pseudo-Mercator (web maps)" },
  { id: "EPSG:8857", description: "WGS 84 / Equal Earth" },
  { id: "EPSG:3413", description: "WGS 84 / NSIDC Polar Stereographic North" },
  { id: "EPSG:3031", description: "WGS 84 / Antarctic Polar Stereographic" },
  { id: "EPSG:3035", description: "ETRS89 / LAEA Europe" },
  { id: "EPSG:5070", description: "NAD83 / Conus Albers" },
];
