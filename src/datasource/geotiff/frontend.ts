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
import type {
  CoordinateArray,
  CoordinateSpaceTransform,
} from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import { GeoTiffTileSourceParameters } from "#src/datasource/geotiff/base.js";
import type {
  TiffTileFormat,
  TiffTileLayout,
} from "#src/datasource/geotiff/decode.js";
import {
  getTiffChunkSize,
  getTiffDataType,
} from "#src/datasource/geotiff/decode.js";
import { getGeoTiffGeoreference } from "#src/datasource/geotiff/geokeys.js";
import {
  alignGeoTiffBands,
  getGeoTiffBandName,
  getGeoTiffDefaultShader,
  getTiffScales,
  resolveGeoTiffBandUrl,
} from "#src/datasource/geotiff/metadata.js";
import type {
  ByteRangeReader,
  TiffFile,
  TiffImage,
} from "#src/datasource/geotiff/tiff.js";
import {
  BlockCachingReader,
  getByteRangeFromResponse,
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
import type { DataType } from "#src/util/data_type.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

class GeoTiffTileSource extends WithParameters(
  WithSharedKvStoreContext(VolumeChunkSource),
  GeoTiffTileSourceParameters,
) {}

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
 * A file of a (possibly multi-file) TIFF image, whose samples form consecutive channels.
 */
export interface GeoTiffBand {
  name: string;
  url: string;
  tiff: TiffFile;
}

export class GeoTiffMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  dataType: DataType;
  volumeType = VolumeType.IMAGE;
  private defaultShader_: string | undefined;
  samplesPerPixel: number;

  get rank() {
    return 3;
  }

  get defaultShader() {
    return this.defaultShader_;
  }

  /**
   * @param levels For each resolution level (ordered by decreasing resolution), the image of each
   *     band (see `alignGeoTiffBands`).
   * @param reference Index of the band whose images define the voxel grid of each level.
   */
  constructor(
    public sharedKvStoreContext: SharedKvStoreContext,
    public bands: GeoTiffBand[],
    public levels: TiffImage[][],
    public reference: number,
  ) {
    super(sharedKvStoreContext.chunkManager);
    const base = levels[0][reference];
    this.dataType = getTiffDataType(base.sampleFormat, base.bitsPerSample);
    this.samplesPerPixel = levels[0].reduce(
      (sum, image) => sum + image.samplesPerPixel,
      0,
    );
    this.defaultShader_ = getGeoTiffDefaultShader(
      this.dataType,
      this.samplesPerPixel,
      base.noData,
    );
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    const { levels, reference, bands, samplesPerPixel: spp } = this;
    const base = levels[0][reference];
    const rank = 3;
    const stride = rank + 1;
    return transposeNestedArrays(
      levels.map((images) => {
        const image = images[reference];
        const chunkToMultiscaleTransform = new Float32Array(stride * stride);
        chunkToMultiscaleTransform[0] = base.width / image.width;
        chunkToMultiscaleTransform[stride + 1] = base.height / image.height;
        chunkToMultiscaleTransform[2 * stride + 2] = 1;
        chunkToMultiscaleTransform[stride * stride - 1] = 1;
        const getLayout = (bandImage: TiffImage): TiffTileLayout => ({
          width: image.width,
          height: image.height,
          tileWidth: bandImage.tileWidth,
          tileHeight: bandImage.tileHeight,
          isTiled: bandImage.isTiled,
          samplesPerPixel: bandImage.samplesPerPixel,
          planarConfiguration: bandImage.planarConfiguration,
        });
        const [chunkWidth, chunkHeight] = getTiffChunkSize(getLayout(image));
        return makeDefaultVolumeChunkSpecifications({
          rank,
          dataType: this.dataType,
          chunkToMultiscaleTransform,
          upperVoxelBound: Float32Array.of(image.width, image.height, spp),
          volumeType: this.volumeType,
          chunkDataSizes: [Uint32Array.of(chunkWidth, chunkHeight, spp)],
          volumeSourceOptions,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(GeoTiffTileSource, {
              sharedKvStoreContext: this.sharedKvStoreContext,
              spec,
              parameters: {
                bands: images.map((bandImage, i) => ({
                  url: bands[i].url,
                  format: getTileFormat(bandImage, bands[i].tiff.littleEndian),
                  layout: getLayout(bandImage),
                  // Tiles (strips) are shared by multiple chunks if the chunks do not consist of
                  // whole tiles.
                  cacheTiles:
                    (chunkWidth % bandImage.tileWidth !== 0 &&
                      chunkWidth !== image.width) ||
                    (chunkHeight % bandImage.tileHeight !== 0 &&
                      chunkHeight !== image.height),
                  offsets: bandImage.offsets,
                  byteCounts: bandImage.byteCounts,
                })),
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
 * Checks that the bands of a multi-file image cover the same extent, to within a pixel of the
 * reference band.  `images` are the full-resolution images of the bands, which (unlike overviews)
 * carry the georeferencing.
 */
function checkGeoTiffBandExtents(
  bands: GeoTiffBand[],
  images: TiffImage[],
  reference: number,
) {
  const extentOf = (image: TiffImage) => {
    const georeference = getGeoTiffGeoreference(image);
    if (georeference === undefined) return undefined;
    const [a00, a10, a01, a11, t0, t1] = georeference.pixelToCrs;
    return {
      crs: georeference.crs,
      corners: [
        [t0, t1],
        [
          t0 + a00 * image.width + a01 * image.height,
          t1 + a10 * image.width + a11 * image.height,
        ],
      ],
      pixel: Math.sqrt(Math.abs(a00 * a11 - a01 * a10)),
    };
  };
  const expected = extentOf(images[reference]);
  for (let i = 0; i < bands.length; ++i) {
    if (i === reference) continue;
    const extent = extentOf(images[i]);
    if ((extent === undefined) !== (expected === undefined)) {
      throw new Error(
        `Band ${JSON.stringify(bands[i].name)} differs in georeferencing from band ${JSON.stringify(bands[reference].name)}`,
      );
    }
    if (extent === undefined || expected === undefined) continue;
    const mismatch = extent.corners.some((corner, k) =>
      corner.some(
        (v, j) => Math.abs(v - expected.corners[k][j]) > expected.pixel,
      ),
    );
    if (extent.crs !== expected.crs || mismatch) {
      throw new Error(
        `Band ${JSON.stringify(bands[i].name)} does not cover the same extent as band ${JSON.stringify(bands[reference].name)}`,
      );
    }
  }
}

/**
 * Constructs the data source for a parsed TIFF file, or for multiple TIFF files whose samples are
 * combined as the channels (bands) of a single image.
 */
export function getGeoTiffDataSource(
  sharedKvStoreContext: SharedKvStoreContext,
  bands: GeoTiffBand[],
  crsOverride: string | undefined,
): DataSource {
  const bandScales = bands.map((band) => getTiffScales(band.tiff));
  const firstBase = bandScales[0][0];
  for (let i = 1; i < bands.length; ++i) {
    const other = bandScales[i][0];
    if (
      other.sampleFormat !== firstBase.sampleFormat ||
      other.bitsPerSample !== firstBase.bitsPerSample
    ) {
      throw new Error(
        `Band ${JSON.stringify(bands[i].name)} differs in data type from band ${JSON.stringify(bands[0].name)}`,
      );
    }
  }
  const { reference, levels } = alignGeoTiffBands(bandScales);
  checkGeoTiffBandExtents(
    bands,
    bandScales.map((scales) => scales[0]),
    reference,
  );
  const base = levels[0][reference];
  const samplesPerPixel = levels[0].reduce(
    (sum, image) => sum + image.samplesPerPixel,
    0,
  );
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
        `Unsupported GeoTIFF CRS${georeference.citation ? ` (${JSON.stringify(georeference.citation)})` : ""}` +
          `${georeference.crsError ? ` (${georeference.crsError})` : ""}: ` +
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
        upperBounds: Float64Array.of(base.width, base.height, samplesPerPixel),
      }),
    ],
    // Channels are labeled by band name for multi-file images.
    coordinateArrays:
      bands.length === 1
        ? undefined
        : [undefined, undefined, getGeoTiffChannelLabels(bands, levels[0])],
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
    bands,
    levels,
    reference,
  );
  return {
    modelTransform,
    subsources: [{ id: "default", default: true, subsource: { volume } }],
    geoReference:
      crs === undefined ? undefined : { crs, modelDimensions: [0, 1] },
  };
}

function getGeoTiffChannelLabels(
  bands: GeoTiffBand[],
  images: TiffImage[],
): CoordinateArray {
  const labels: string[] = [];
  bands.forEach((band, i) => {
    const n = images[i].samplesPerPixel;
    for (let k = 0; k < n; ++k) {
      labels.push(n === 1 ? band.name : `${band.name}.${k}`);
    }
  });
  return {
    explicit: false,
    coordinates: Array.from(labels, (_, i) => i),
    labels,
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
      return getByteRangeFromResponse(response, offset, length);
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
  if (initial.offset === 0) {
    const data = new Uint8Array(await initial.response.arrayBuffer());
    // The server may ignore the byte range and return the entire file.
    reader.seedBlock(
      0,
      data.length > blockSize ? data.slice(0, blockSize) : data,
    );
  }
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
        `Invalid URL ${JSON.stringify(options.url.url)}: expected "geotiff:" optionally followed by "#crs=<CRS>&bands=<files>"`,
      );
    }
    let crsOverride: string | undefined;
    const { kvStoreUrl } = options;
    // Additional files whose samples are appended as channels, e.g. the other bands of a
    // Sentinel-2 scene, relative to the URL of the first file.
    const bandUrls = [kvStoreUrl];
    if (fragment) {
      const params = new URLSearchParams(fragment);
      for (const key of params.keys()) {
        if (key !== "crs" && key !== "bands") {
          throw new Error(`Unsupported GeoTIFF option: ${JSON.stringify(key)}`);
        }
      }
      crsOverride = params.get("crs") ?? undefined;
      const bandsParam = params.get("bands");
      if (bandsParam) {
        for (const band of bandsParam.split(",")) {
          if (band) bandUrls.push(resolveGeoTiffBandUrl(kvStoreUrl, band));
        }
      }
    }
    return options.registry.chunkManager.memoize.getAsync(
      { type: "geotiff:get", urls: bandUrls, crsOverride },
      options,
      async (progressOptions): Promise<DataSource> => {
        const { sharedKvStoreContext } = options.registry;
        const tiffs = await Promise.all(
          bandUrls.map((url) =>
            readTiffMetadata(sharedKvStoreContext, url, progressOptions),
          ),
        );
        const bands = bandUrls.map((url, i) => ({
          name: getGeoTiffBandName(url),
          url,
          tiff: tiffs[i],
        }));
        return {
          ...getGeoTiffDataSource(sharedKvStoreContext, bands, crsOverride),
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
