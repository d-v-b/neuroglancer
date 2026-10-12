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
 * @file Data source for (Cloud-Optimized) GeoTIFF images.
 *
 * URL syntax: `<kvstore url>|geotiff:`, optionally followed by `#crs=<CRS>` to override or specify
 * the CRS, e.g. `https://example.com/image.tif|geotiff:#crs=EPSG:31468`.
 *
 * Reduced-resolution images (overviews) are used as additional scales.  Only the byte ranges of
 * the image file directories and the required tiles are read.
 */

import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { GeoTiffTileSourceParameters } from "#src/datasource/geotiff/base.js";
import type { TiffTileFormat } from "#src/datasource/geotiff/decode.js";
import { getTiffDataType } from "#src/datasource/geotiff/decode.js";
import { getGeoTiffGeoreference } from "#src/datasource/geotiff/geokeys.js";
import type {
  ByteRangeReader,
  TiffFile,
  TiffImage,
} from "#src/datasource/geotiff/tiff.js";
import {
  BlockCachingReader,
  isTiffHeader,
  readTiff,
} from "#src/datasource/geotiff/tiff.js";
import type {
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { getCrs } from "#src/geo/crs.js";
import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { WithSharedKvStoreContext } from "#src/kvstore/chunk_source_frontend.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { parseUrlSuffix } from "#src/kvstore/url.js";
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
import { DataType } from "#src/util/data_type.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

class GeoTiffTileSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  GeoTiffTileSourceParameters,
) {}

/**
 * Selects the full-resolution image and its overviews, ordered by decreasing resolution.
 */
export function getTiffScales(tiff: TiffFile): TiffImage[] {
  const isMask = (image: TiffImage) => (image.subfileType & 4) !== 0;
  const isOverview = (image: TiffImage) => (image.subfileType & 1) !== 0;
  const base = tiff.images.find(
    (image) => !isMask(image) && !isOverview(image),
  );
  if (base === undefined) {
    throw new Error("TIFF file contains no full-resolution image");
  }
  const scales = [base];
  for (const image of tiff.images) {
    if (image === base || isMask(image) || !isOverview(image)) continue;
    if (
      image.samplesPerPixel !== base.samplesPerPixel ||
      image.bitsPerSample !== base.bitsPerSample ||
      image.sampleFormat !== base.sampleFormat ||
      image.width >= base.width
    ) {
      continue;
    }
    scales.push(image);
  }
  scales.sort((a, b) => b.width - a.width);
  return scales;
}

function getTileFormat(
  image: TiffImage,
  littleEndian: boolean,
): TiffTileFormat {
  return {
    compression: image.compression,
    predictor: image.predictor,
    bitsPerSample: image.bitsPerSample,
    sampleFormat: image.sampleFormat,
    samplesPerTile: image.planarConfiguration === 2 ? 1 : image.samplesPerPixel,
    littleEndian,
    tileWidth: image.tileWidth,
    tileHeight: image.tileHeight,
    jpegTables: image.jpegTables,
  };
}

/**
 * Returns the default shader for an image, or `undefined` to use the generic default.
 */
export function getGeoTiffDefaultShader(
  dataType: DataType,
  samplesPerPixel: number,
  noData: number | undefined,
): string | undefined {
  if (dataType !== DataType.UINT8) return undefined;
  if (samplesPerPixel === 3) {
    const alpha =
      noData === 0 ? "all(equal(rgb, vec3(0.0))) ? 0.0 : 1.0" : "1.0";
    return `void main() {
  vec3 rgb = vec3(toNormalized(getDataValue(0)),
                  toNormalized(getDataValue(1)),
                  toNormalized(getDataValue(2)));
  emitRGBA(vec4(rgb, ${alpha}));
}
`;
  }
  if (samplesPerPixel === 4) {
    return `void main() {
  emitRGBA(vec4(toNormalized(getDataValue(0)),
                toNormalized(getDataValue(1)),
                toNormalized(getDataValue(2)),
                toNormalized(getDataValue(3))));
}
`;
  }
  return undefined;
}

export class GeoTiffMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType = VolumeType.IMAGE;
  private defaultShader_: string | undefined;

  get rank() {
    return 3;
  }

  get defaultShader() {
    return this.defaultShader_;
  }

  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public url: string,
    public tiff: TiffFile,
    public scales: TiffImage[],
  ) {
    super(sharedKvStoreContext.chunkManager);
    const base = scales[0];
    this.dataType = getTiffDataType(base.sampleFormat, base.bitsPerSample);
    this.defaultShader_ = getGeoTiffDefaultShader(
      this.dataType,
      base.samplesPerPixel,
      base.noData,
    );
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const { scales, tiff } = this;
    const base = scales[0];
    const rank = 3;
    const stride = rank + 1;
    const spp = base.samplesPerPixel;
    return transposeNestedArrays(
      scales.map((image) => {
        const chunkToMultiscaleTransform = new Float32Array(stride * stride);
        chunkToMultiscaleTransform[0] = base.width / image.width;
        chunkToMultiscaleTransform[stride + 1] = base.height / image.height;
        chunkToMultiscaleTransform[2 * stride + 2] = 1;
        chunkToMultiscaleTransform[stride * stride - 1] = 1;
        const tilesAcross = Math.ceil(image.width / image.tileWidth);
        const tilesDown = Math.ceil(image.height / image.tileHeight);
        return makeDefaultVolumeChunkSpecifications({
          rank,
          dataType: this.dataType,
          chunkToMultiscaleTransform,
          upperVoxelBound: Float32Array.of(image.width, image.height, spp),
          volumeType: this.volumeType,
          chunkDataSizes: [
            Uint32Array.of(image.tileWidth, image.tileHeight, spp),
          ],
          volumeSourceOptions,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(GeoTiffTileSource, {
              sharedKvStoreContext: this.sharedKvStoreContext,
              spec,
              parameters: {
                url: this.url,
                format: getTileFormat(image, tiff.littleEndian),
                samplesPerPixel: spp,
                planarConfiguration: image.planarConfiguration,
                tilesAcross,
                tilesPerPlane: tilesAcross * tilesDown,
                offsets: image.offsets,
                byteCounts: image.byteCounts,
              },
            }),
            chunkToMultiscaleTransform,
          }),
        );
      }),
    );
  }
}

/**
 * Constructs the data source for a parsed TIFF file.
 */
export function getGeoTiffDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  tiff: TiffFile,
  crsOverride: string | undefined,
): DataSource {
  const scales = getTiffScales(tiff);
  const base = scales[0];
  const georeference = getGeoTiffGeoreference(base);
  const names = ["x", "y", "c^"];
  const rank = 3;
  const stride = rank + 1;
  const transform = new Float64Array(stride * stride);
  transform[stride * stride - 1] = 1;
  transform[2 * stride + 2] = 1;
  let units: string[];
  let scale: number;
  let crs: string | undefined;
  if (georeference === undefined) {
    if (crsOverride !== undefined) {
      throw new Error(
        "TIFF file is not georeferenced (missing ModelTransformation or ModelTiepoint/ModelPixelScale tags)",
      );
    }
    // Not georeferenced: use pixel coordinates.
    units = ["", "", ""];
    scale = 1;
    transform[0] = 1;
    transform[stride + 1] = 1;
  } else {
    crs = crsOverride ?? georeference.crs;
    if (crs === undefined) {
      throw new Error(
        `Unsupported GeoTIFF CRS${georeference.citation ? ` (${JSON.stringify(georeference.citation)})` : ""}: ` +
          `specify the CRS explicitly, e.g. "|geotiff:#crs=EPSG:<code>" or "|geotiff:#crs=+proj=..."`,
      );
    }
    const crsInfo = getCrs(crs);
    crs = crsInfo.id;
    const unit = crsInfo.unit === "deg" ? "deg" : "m";
    units = [unit, unit, ""];
    // Model coordinates are in the native units of the CRS (labelled "m" for all linear units,
    // since the reprojection operates on native units).
    const [a00, a10, a01, a11, t0, t1] = georeference.pixelToCrs;
    scale = Math.sqrt(Math.abs(a00 * a11 - a01 * a10));
    // Coefficients map input base units to output base units; the input scale equals `scale`.
    transform[0] = a00 / scale;
    transform[1] = a10 / scale;
    transform[stride] = a01 / scale;
    transform[stride + 1] = a11 / scale;
    transform[rank * stride] = t0 / scale;
    transform[rank * stride + 1] = t1 / scale;
  }
  const scalesArray = Float64Array.of(scale, scale, 1);
  const inputSpace = makeCoordinateSpace({
    names,
    units,
    scales: scalesArray,
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: new Float64Array(rank),
        upperBounds: Float64Array.of(
          base.width,
          base.height,
          base.samplesPerPixel,
        ),
      }),
    ],
  });
  const outputSpace = makeCoordinateSpace({
    names,
    units,
    scales: scalesArray,
  });
  const modelTransform: CoordinateSpaceTransform = {
    rank,
    sourceRank: rank,
    inputSpace,
    outputSpace,
    transform,
  };
  const volume = new GeoTiffMultiscaleVolumeChunkSource(
    sharedKvStoreContext,
    url,
    tiff,
    scales,
  );
  return {
    modelTransform,
    subsources: [{ id: "default", default: true, subsource: { volume } }],
    geoReference:
      crs === undefined ? undefined : { crs, modelDimensions: [0, 1] },
  };
}

function makeKvStoreReader(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): ByteRangeReader {
  return {
    async read(offset, length) {
      const response = await sharedKvStoreContext.kvStoreContext.read(url, {
        ...options,
        byteRange: { offset, length },
        throwIfMissing: true,
      });
      return new Uint8Array(await response.response.arrayBuffer());
    },
  };
}

async function readTiffMetadata(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: ProgressOptions,
): Promise<TiffFile> {
  using _span = new ProgressSpan(options.progressListener, {
    message: `Reading TIFF metadata from ${url}`,
  });
  // Determine the file size from an initial read, to avoid reading beyond the end of the file.
  const blockSize = 65536;
  const initial = await sharedKvStoreContext.kvStoreContext.read(url, {
    ...options,
    byteRange: { offset: 0, length: blockSize },
    throwIfMissing: true,
  });
  const reader = new BlockCachingReader(
    makeKvStoreReader(sharedKvStoreContext, url, options),
    blockSize,
    initial.totalSize,
  );
  return await readTiff(reader);
}

export class GeoTiffDataSourceProvider
  implements KvStoreBasedDataSourceProvider
{
  get scheme() {
    return "geotiff";
  }

  get description() {
    return "GeoTIFF / Cloud-Optimized GeoTIFF";
  }

  get singleFile() {
    return true;
  }

  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    const { authorityAndPath, query, fragment } = parseUrlSuffix(
      options.url.suffix,
    );
    if (authorityAndPath || query) {
      throw new Error(
        `Invalid URL ${JSON.stringify(options.url.url)}: expected "geotiff:" optionally followed by "#crs=<CRS>"`,
      );
    }
    let crsOverride: string | undefined;
    if (fragment) {
      const params = new URLSearchParams(fragment);
      for (const key of params.keys()) {
        if (key !== "crs") {
          throw new Error(`Unsupported GeoTIFF option: ${JSON.stringify(key)}`);
        }
      }
      crsOverride = params.get("crs") ?? undefined;
    }
    const { kvStoreUrl } = options;
    return options.registry.chunkManager.memoize.getAsync(
      { type: "geotiff:get", url: kvStoreUrl, crsOverride },
      options,
      async (progressOptions): Promise<DataSource> => {
        const { sharedKvStoreContext } = options.registry;
        const tiff = await readTiffMetadata(
          sharedKvStoreContext,
          kvStoreUrl,
          progressOptions,
        );
        return {
          ...getGeoTiffDataSource(
            sharedKvStoreContext,
            kvStoreUrl,
            tiff,
            crsOverride,
          ),
          canonicalUrl: `${kvStoreUrl}|${options.url.url}`,
        };
      },
    );
  }
}

async function detectFormat(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  if (isTiffHeader(options.prefix)) {
    return [{ suffix: "geotiff:", description: "GeoTIFF" }];
  }
  return [];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    prefixLength: 4,
    suffixLength: 0,
    match: detectFormat,
  });
}
