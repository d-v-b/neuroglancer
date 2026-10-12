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

import type { TiffTileFormat } from "#src/datasource/geotiff/decode.js";

export class GeoTiffTileSourceParameters {
  url: string;
  format: TiffTileFormat;
  samplesPerPixel: number;
  planarConfiguration: number;
  /**
   * Number of tiles across the width of the image.
   */
  tilesAcross: number;
  /**
   * Number of tiles per sample plane.
   */
  tilesPerPlane: number;
  offsets: number[];
  byteCounts: number[];

  static RPC_ID = "geotiff/TileSource";
}
