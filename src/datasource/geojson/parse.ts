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
 * @file Parsing of GeoJSON (RFC 7946) feature collections into points and line strings.
 */

/**
 * Interpretation of the third coordinate of GeoJSON positions.
 *
 * - `elevation_m`: elevation in meters (as specified by RFC 7946).
 * - `depth_km`: depth in kilometers, as used by the USGS earthquake catalog.
 * - `none`: ignored.
 */
export type GeoJsonVerticalCoordinate = "elevation_m" | "depth_km" | "none";

export interface GeoJsonNumericProperty {
  /**
   * Property name in the GeoJSON, or `undefined` for derived properties.
   */
  key: string | undefined;
  /**
   * Identifier, valid as a GLSL identifier suffix (for `prop_<identifier>()`).
   */
  identifier: string;
  description: string | undefined;
}

export interface GeoJsonPoint {
  lon: number;
  lat: number;
  /**
   * Elevation in meters (positive up), if the position has a vertical coordinate.
   */
  elevation: number | undefined;
  properties: number[];
  description: string | undefined;
}

export interface GeoJsonLineString {
  /**
   * Positions `[lon0, lat0, elevation0, lon1, ...]`, with elevation `NaN` if not specified.
   */
  positions: number[];
  properties: number[];
  description: string | undefined;
}

export interface ParsedGeoJson {
  points: GeoJsonPoint[];
  lineStrings: GeoJsonLineString[];
  properties: GeoJsonNumericProperty[];
  /**
   * Indicates that some positions have a vertical coordinate.
   */
  hasVertical: boolean;
  /**
   * Bounds `[lonMin, latMin, lonMax, latMax]` of all positions.
   */
  bounds: [number, number, number, number];
  /**
   * Range of elevations `[min, max]` in meters, if `hasVertical`.
   */
  elevationRange: [number, number];
}

const MAX_PROPERTIES = 16;
const PROPERTY_SAMPLE_SIZE = 1000;
const DESCRIPTION_KEYS = ["title", "name", "Name", "NAME", "place", "label"];

/**
 * Converts a property name to a valid GLSL identifier suffix.
 */
export function sanitizePropertyIdentifier(key: string): string {
  let identifier = key.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z]/.test(identifier)) identifier = `p_${identifier}`;
  // GLSL reserves identifiers containing consecutive underscores.
  identifier = identifier.replace(/__+/g, "_");
  return identifier;
}

function isFeatureCollection(json: any) {
  return (
    json !== null &&
    typeof json === "object" &&
    json.type === "FeatureCollection"
  );
}

/**
 * Determines whether a JSON value looks like GeoJSON.
 */
export function isGeoJson(json: any): boolean {
  if (json === null || typeof json !== "object") return false;
  return (
    isFeatureCollection(json) ||
    json.type === "Feature" ||
    [
      "Point",
      "MultiPoint",
      "LineString",
      "MultiLineString",
      "Polygon",
      "MultiPolygon",
      "GeometryCollection",
    ].includes(json.type)
  );
}

/**
 * Infers the interpretation of vertical coordinates.  The USGS earthquake catalog specifies depth
 * in kilometers rather than elevation in meters.
 */
export function inferVerticalCoordinate(json: any): GeoJsonVerticalCoordinate {
  const url = json?.metadata?.url;
  if (typeof url === "string" && url.includes("earthquake.usgs.gov")) {
    return "depth_km";
  }
  return "elevation_m";
}

function getFeatures(json: any): any[] {
  if (isFeatureCollection(json)) {
    if (!Array.isArray(json.features)) {
      throw new Error("GeoJSON FeatureCollection must have a features array");
    }
    return json.features;
  }
  if (json.type === "Feature") return [json];
  return [{ type: "Feature", geometry: json, properties: {} }];
}

/**
 * Parses GeoJSON into points and line strings.  Polygons are represented by their rings.
 */
export function parseGeoJson(
  json: any,
  vertical: GeoJsonVerticalCoordinate,
): ParsedGeoJson {
  if (!isGeoJson(json)) {
    throw new Error("Not a GeoJSON object");
  }
  const features = getFeatures(json);

  // Determine numeric properties from a sample of features.
  const counts = new Map<string, { numeric: number; total: number }>();
  for (const feature of features.slice(0, PROPERTY_SAMPLE_SIZE)) {
    const props = feature?.properties;
    if (props == null || typeof props !== "object") continue;
    for (const [key, value] of Object.entries(props)) {
      let entry = counts.get(key);
      if (entry === undefined) {
        entry = { numeric: 0, total: 0 };
        counts.set(key, entry);
      }
      if (value === null) continue;
      ++entry.total;
      if (typeof value === "number" && Number.isFinite(value)) ++entry.numeric;
    }
  }
  const properties: GeoJsonNumericProperty[] = [];
  const usedIdentifiers = new Set<string>();
  const addProperty = (
    key: string | undefined,
    name: string,
    description?: string,
  ) => {
    let identifier = sanitizePropertyIdentifier(name);
    while (usedIdentifiers.has(identifier)) identifier += "_";
    usedIdentifiers.add(identifier);
    properties.push({ key, identifier, description });
  };
  for (const [key, { numeric, total }] of counts) {
    if (properties.length >= MAX_PROPERTIES) break;
    if (numeric > 0 && numeric === total) addProperty(key, key);
  }

  const points: GeoJsonPoint[] = [];
  const lineStrings: GeoJsonLineString[] = [];
  let hasVertical = false;
  const bounds: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  const elevationRange: [number, number] = [Infinity, -Infinity];

  const getElevation = (position: any): number | undefined => {
    if (vertical === "none" || position.length < 3) return undefined;
    const z = position[2];
    if (typeof z !== "number" || !Number.isFinite(z)) return undefined;
    hasVertical = true;
    const elevation = vertical === "depth_km" ? -z * 1000 : z;
    elevationRange[0] = Math.min(elevationRange[0], elevation);
    elevationRange[1] = Math.max(elevationRange[1], elevation);
    return elevation;
  };
  const checkPosition = (position: any) => {
    if (
      !Array.isArray(position) ||
      position.length < 2 ||
      typeof position[0] !== "number" ||
      typeof position[1] !== "number" ||
      !Number.isFinite(position[0]) ||
      !Number.isFinite(position[1])
    ) {
      return false;
    }
    bounds[0] = Math.min(bounds[0], position[0]);
    bounds[1] = Math.min(bounds[1], position[1]);
    bounds[2] = Math.max(bounds[2], position[0]);
    bounds[3] = Math.max(bounds[3], position[1]);
    return true;
  };

  for (const feature of features) {
    if (feature == null || typeof feature !== "object") continue;
    const props = feature.properties ?? {};
    const propertyValues = properties.map(({ key }) => {
      if (key === undefined) return 0;
      const value = props[key];
      return typeof value === "number" ? value : Number.NaN;
    });
    let description: string | undefined;
    for (const key of DESCRIPTION_KEYS) {
      if (typeof props[key] === "string") {
        description = props[key];
        break;
      }
    }
    const addPoint = (position: any) => {
      if (!checkPosition(position)) return;
      points.push({
        lon: position[0],
        lat: position[1],
        elevation: getElevation(position),
        properties: propertyValues,
        description,
      });
    };
    const addLineString = (positions: any) => {
      if (!Array.isArray(positions)) return;
      const flat: number[] = [];
      for (const position of positions) {
        if (!checkPosition(position)) continue;
        flat.push(
          position[0],
          position[1],
          getElevation(position) ?? Number.NaN,
        );
      }
      if (flat.length >= 6) {
        lineStrings.push({
          positions: flat,
          properties: propertyValues,
          description,
        });
      }
    };
    const addGeometry = (geometry: any) => {
      if (geometry == null || typeof geometry !== "object") return;
      const { coordinates } = geometry;
      switch (geometry.type) {
        case "Point":
          addPoint(coordinates);
          break;
        case "MultiPoint":
          for (const p of coordinates ?? []) addPoint(p);
          break;
        case "LineString":
          addLineString(coordinates);
          break;
        case "MultiLineString":
        case "Polygon":
          for (const l of coordinates ?? []) addLineString(l);
          break;
        case "MultiPolygon":
          for (const polygon of coordinates ?? []) {
            for (const l of polygon ?? []) addLineString(l);
          }
          break;
        case "GeometryCollection":
          for (const g of geometry.geometries ?? []) addGeometry(g);
          break;
      }
    };
    addGeometry(feature.geometry);
  }
  if (points.length === 0 && lineStrings.length === 0) {
    throw new Error("GeoJSON contains no point or line geometries");
  }
  if (hasVertical) {
    // Derived property for shaders: depth in kilometers.
    addProperty(undefined, "depth_km", "Depth (km)");
    const index = properties.length - 1;
    for (const point of points) {
      point.properties = [...point.properties];
      point.properties[index] =
        point.elevation === undefined ? Number.NaN : -point.elevation / 1000;
    }
    for (const lineString of lineStrings) {
      lineString.properties = [...lineString.properties];
      lineString.properties[index] = Number.NaN;
    }
  } else {
    elevationRange[0] = elevationRange[1] = 0;
  }
  return {
    points,
    lineStrings,
    properties,
    hasVertical,
    bounds,
    elevationRange,
  };
}
