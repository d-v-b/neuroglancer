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

import type {
  TiffTileFormat,
  TiffTileLayout,
} from "#src/datasource/geotiff/decode.js";

/**
 * Parameters for reading one file (band) of a TIFF image, at one resolution level.
 */
export interface GeoTiffBandParameters {
  url: string;
  format: TiffTileFormat;
  layout: TiffTileLayout;
  /**
   * Indicates that tiles (strips) may be shared by multiple chunks, such that decoded tiles should
   * be cached.
   */
  cacheTiles: boolean;
  offsets: number[];
  byteCounts: number[];
}

export class GeoTiffTileSourceParameters {
  /**
   * The files whose samples form the channels of the chunks, in order.  All have the same size.
   */
  bands: GeoTiffBandParameters[];

  static RPC_ID = "geotiff/TileSource";
}
