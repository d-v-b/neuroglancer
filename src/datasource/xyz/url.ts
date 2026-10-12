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
 * @file Parsing of xyz:// data source URLs.
 */

import { getCrs } from "#src/geo/crs.js";

export interface TileMatrixSet {
  crs: string;
  /**
   * Top-left corner of the tile matrix in CRS units.
   */
  originX: number;
  originY: number;
  /**
   * Resolution (CRS units per pixel) at zoom level 0.
   */
  resolution0: number;
  /**
   * Number of tile columns and rows at zoom level 0.
   */
  columns0: number;
  rows0: number;
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  /**
   * Bounds of valid data in CRS units, `[xmin, ymin, xmax, ymax]`, if smaller than the extent of
   * the tile matrix.
   */
  dataBounds?: [number, number, number, number];
}

export interface XyzUrlInfo {
  urlTemplate: string;
  tileMatrixSet: TileMatrixSet;
  subdomains: string[];
}

const WEB_MERCATOR_HALF_EXTENT = Math.PI * 6378137;

/**
 * Parses an `xyz://` provider URL (excluding the `xyz://` prefix).
 */
export function parseXyzUrl(providerUrl: string): XyzUrlInfo {
  const hashIndex = providerUrl.indexOf("#");
  const urlTemplate =
    hashIndex === -1 ? providerUrl : providerUrl.substring(0, hashIndex);
  const optionsString =
    hashIndex === -1 ? "" : providerUrl.substring(hashIndex + 1);
  if (
    !/\{z\}/.test(urlTemplate) ||
    !/\{x\}/.test(urlTemplate) ||
    !/\{-?y\}/.test(urlTemplate)
  ) {
    throw new Error(
      "XYZ URL template must contain {z}, {x}, and {y} (or {-y}) placeholders",
    );
  }
  const options = new Map<string, string>();
  for (const part of optionsString.split("&")) {
    if (part === "") continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`Invalid XYZ option: ${JSON.stringify(part)}`);
    }
    options.set(
      decodeURIComponent(part.substring(0, eqIndex)).toLowerCase(),
      decodeURIComponent(part.substring(eqIndex + 1)),
    );
  }
  const parseNumber = (key: string, defaultValue: number) => {
    const value = options.get(key);
    options.delete(key);
    if (value === undefined) return defaultValue;
    const x = Number(value);
    if (!Number.isFinite(x)) {
      throw new Error(
        `Invalid value for XYZ option ${key}: ${JSON.stringify(value)}`,
      );
    }
    return x;
  };
  const crsId = getCrs(options.get("crs") ?? "EPSG:3857").id;
  options.delete("crs");
  const tileSize = parseNumber("tilesize", 256);
  if (!Number.isInteger(tileSize) || tileSize <= 0 || tileSize > 4096) {
    throw new Error(`Invalid XYZ tile size: ${tileSize}`);
  }
  const minZoom = parseNumber("minzoom", 0);
  const maxZoom = parseNumber("maxzoom", 18);
  if (
    !Number.isInteger(minZoom) ||
    !Number.isInteger(maxZoom) ||
    minZoom < 0 ||
    maxZoom < minZoom ||
    maxZoom > 30
  ) {
    throw new Error(`Invalid XYZ zoom range: [${minZoom}, ${maxZoom}]`);
  }
  let tileMatrixSet: TileMatrixSet;
  if (crsId === "EPSG:3857") {
    tileMatrixSet = {
      crs: crsId,
      originX: -WEB_MERCATOR_HALF_EXTENT,
      originY: WEB_MERCATOR_HALF_EXTENT,
      resolution0: (2 * WEB_MERCATOR_HALF_EXTENT) / tileSize,
      columns0: 1,
      rows0: 1,
      tileSize,
      minZoom,
      maxZoom,
    };
  } else if (crsId === "EPSG:4326") {
    tileMatrixSet = {
      crs: crsId,
      originX: -180,
      originY: 90,
      resolution0: 180 / tileSize,
      columns0: 2,
      rows0: 1,
      tileSize,
      minZoom,
      maxZoom,
    };
  } else {
    // Other CRSs require an explicit tile matrix.
    if (!options.has("resolution") || !options.has("origin")) {
      throw new Error(
        `XYZ tiles in ${crsId} require the "resolution" and "origin" options`,
      );
    }
    tileMatrixSet = {
      crs: crsId,
      originX: 0,
      originY: 0,
      resolution0: 1,
      columns0: 1,
      rows0: 1,
      tileSize,
      minZoom,
      maxZoom,
    };
  }
  const originOption = options.get("origin");
  options.delete("origin");
  if (originOption !== undefined) {
    const parts = originOption.split(",").map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) {
      throw new Error(`Invalid XYZ origin: ${JSON.stringify(originOption)}`);
    }
    [tileMatrixSet.originX, tileMatrixSet.originY] = parts;
  }
  tileMatrixSet.resolution0 = parseNumber(
    "resolution",
    tileMatrixSet.resolution0,
  );
  if (!(tileMatrixSet.resolution0 > 0)) {
    throw new Error(`Invalid XYZ resolution: ${tileMatrixSet.resolution0}`);
  }
  tileMatrixSet.columns0 = parseNumber("columns", tileMatrixSet.columns0);
  tileMatrixSet.rows0 = parseNumber("rows", tileMatrixSet.rows0);
  const subdomainsOption = options.get("subdomains");
  options.delete("subdomains");
  const subdomains =
    subdomainsOption === undefined
      ? /\{s\}/.test(urlTemplate)
        ? ["a", "b", "c"]
        : []
      : subdomainsOption.includes(",")
        ? subdomainsOption.split(",")
        : Array.from(subdomainsOption);
  if (options.size !== 0) {
    throw new Error(
      `Unsupported XYZ options: ${Array.from(options.keys()).join(", ")}`,
    );
  }
  return { urlTemplate, tileMatrixSet, subdomains };
}
