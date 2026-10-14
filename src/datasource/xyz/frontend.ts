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
import type { XyzUrlInfo } from "#src/datasource/xyz/url.js";
import { parseXyzUrl } from "#src/datasource/xyz/url.js";
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
