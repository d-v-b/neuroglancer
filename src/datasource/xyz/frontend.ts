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
 * @file Data source for map tiles addressed by zoom level and tile column/row (XYZ, TMS, and
 * WMTS RESTful URLs), such as web map basemaps.
 *
 * URL syntax:
 *
 *     xyz://<url template>#<options>
 *
 * where the URL template contains `{z}`, `{x}`, and `{y}` (or `{-y}` for TMS row order)
 * placeholders, and optionally `{s}` for subdomains.  Options are `&`-separated `key=value`
 * pairs:
 *
 *   - `crs`: tile matrix set, either `EPSG:3857` (default; Google Maps compatible, a single tile at
 *     zoom level 0) or `EPSG:4326` (WorldCRS84Quad, two tiles at zoom level 0).
 *   - `tilesize`: tile size in pixels (default 256).
 *   - `minzoom`, `maxzoom`: range of zoom levels (default 0 and 18).
 *   - `resolution`: resolution at zoom level 0 in CRS units per pixel, overriding the default of
 *     the tile matrix set.
 *   - `origin`: top-left corner `x,y` of the tile matrix in CRS units.
 *   - `subdomains`: values substituted for `{s}`, e.g. `abc`.
 *
 * Tiles may be in any image format supported by the browser, and are loaded as 4-channel RGBA
 * data.
 */

import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  CompleteUrlOptions,
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { XyzTileSourceParameters } from "#src/datasource/xyz/base.js";
import { getCrs, WEB_MERCATOR_MAX_LATITUDE } from "#src/geo/crs.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { emptyCompletionResult } from "#src/util/completion.js";
import { DataType } from "#src/util/data_type.js";

class XyzTileSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  XyzTileSourceParameters,
) {}

/**
 * Default shader for RGBA map tiles.
 */
export const RGBA_IMAGE_SHADER = `void main() {
  emitRGBA(vec4(toNormalized(getDataValue(0)),
                toNormalized(getDataValue(1)),
                toNormalized(getDataValue(2)),
                toNormalized(getDataValue(3))));
}
`;

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

export class XyzMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  get dataType() {
    return DataType.UINT8;
  }

  get volumeType() {
    return VolumeType.IMAGE;
  }

  get rank() {
    return 3;
  }

  get defaultShader() {
    return RGBA_IMAGE_SHADER;
  }

  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public info: XyzUrlInfo,
  ) {
    super(sharedKvStoreContext.chunkManager);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const { tileMatrixSet, urlTemplate, subdomains } = this.info;
    const { tileSize, minZoom, maxZoom, columns0, rows0 } = tileMatrixSet;
    const rank = 3;
    const stride = rank + 1;
    const levels: SliceViewSingleResolutionSource<VolumeChunkSource>[][] = [];
    for (let zoom = maxZoom; zoom >= minZoom; --zoom) {
      const downsampleFactor = 2 ** (maxZoom - zoom);
      const columns = columns0 * 2 ** zoom;
      const rows = rows0 * 2 ** zoom;
      const chunkToMultiscaleTransform = new Float32Array(stride * stride);
      chunkToMultiscaleTransform[0] = downsampleFactor;
      chunkToMultiscaleTransform[stride + 1] = downsampleFactor;
      chunkToMultiscaleTransform[2 * stride + 2] = 1;
      chunkToMultiscaleTransform[stride * stride - 1] = 1;
      const specs = makeDefaultVolumeChunkSpecifications({
        rank,
        dataType: this.dataType,
        chunkToMultiscaleTransform,
        upperVoxelBound: Float32Array.of(
          columns * tileSize,
          rows * tileSize,
          4,
        ),
        volumeType: this.volumeType,
        chunkDataSizes: [Uint32Array.of(tileSize, tileSize, 4)],
        volumeSourceOptions,
      });
      levels.push(
        specs.map((spec) => ({
          chunkSource: this.chunkManager.getChunkSource(XyzTileSource, {
            sharedKvStoreContext: this.sharedKvStoreContext,
            spec,
            parameters: {
              urlTemplate,
              zoom,
              tileSize,
              numRows: rows,
              subdomains,
            },
          }),
          chunkToMultiscaleTransform,
        })),
      );
    }
    return transposeNestedArrays(levels);
  }
}

export function getXyzDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  providerUrl: string,
): DataSource {
  const info = parseXyzUrl(providerUrl);
  const { tileMatrixSet } = info;
  const { tileSize, maxZoom, resolution0, originX, originY, columns0, rows0 } =
    tileMatrixSet;
  const crs = getCrs(tileMatrixSet.crs);
  const resolution = resolution0 / 2 ** maxZoom;
  const width = columns0 * 2 ** maxZoom * tileSize;
  const height = rows0 * 2 ** maxZoom * tileSize;
  const unit = crs.unit === "deg" ? "deg" : "m";
  const names = ["x", "y", "c^"];
  const units = [unit, unit, ""];
  const scales = Float64Array.of(resolution, resolution, 1);
  const lowerBounds = Float64Array.of(0, 0, 0);
  const upperBounds = Float64Array.of(width, height, 4);
  if (tileMatrixSet.crs === "EPSG:3857") {
    // Exclude rows beyond the latitude limit, if any (e.g. for non-square tile matrices).
    const limit =
      6378137 *
      Math.log(
        Math.tan(Math.PI / 4 + (WEB_MERCATOR_MAX_LATITUDE * Math.PI) / 360),
      );
    lowerBounds[1] = Math.max(0, (originY - limit) / resolution);
    upperBounds[1] = Math.min(height, (originY + limit) / resolution);
  }
  const inputSpace = makeCoordinateSpace({
    names,
    units,
    scales,
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
    ],
  });
  const outputSpace = makeCoordinateSpace({ names, units, scales });
  // Voxel (column, row) -> CRS (originX + column * resolution, originY - row * resolution).
  const transform = new Float64Array(16);
  transform[0] = 1;
  transform[5] = -1;
  transform[10] = 1;
  transform[12] = originX / resolution;
  transform[13] = originY / resolution;
  transform[15] = 1;
  const volume = new XyzMultiscaleVolumeChunkSource(sharedKvStoreContext, info);
  return {
    modelTransform: {
      rank: 3,
      sourceRank: 3,
      inputSpace,
      outputSpace,
      transform,
    },
    subsources: [{ id: "default", default: true, subsource: { volume } }],
    geoReference: { crs: crs.id, modelDimensions: [0, 1] },
  };
}

export class XyzDataSourceProvider implements DataSourceProvider {
  get scheme() {
    return "xyz";
  }

  get description() {
    return "Map tiles (XYZ/TMS/WMTS URL template)";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    const { providerUrl } = options;
    return options.registry.chunkManager.memoize.getUncounted(
      { type: "xyz:get", providerUrl },
      () =>
        getXyzDataSource(options.registry.sharedKvStoreContext, providerUrl),
    );
  }

  async completeUrl(options: CompleteUrlOptions) {
    options;
    return emptyCompletionResult;
  }
}
