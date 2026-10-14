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

export class XyzTileSourceParameters {
  /**
   * Tile URL template containing `{z}`, `{x}`, and `{y}` (or `{-y}`) placeholders.
   */
  urlTemplate: string;

  /**
   * Zoom level of this source.
   */
  zoom: number;

  /**
   * Tile size in pixels.
   */
  tileSize: number;

  /**
   * Number of tiles along y at this zoom level, used for `{-y}` (TMS) placeholders.
   */
  numRows: number;

  /**
   * Values substituted for `{s}` placeholders, chosen based on the tile position.
   */
  subdomains: string[];

  static RPC_ID = "xyz/TileSource";
}

/**
 * Returns the URL of a tile.
 */
export function getXyzTileUrl(
  parameters: XyzTileSourceParameters,
  x: number,
  y: number,
) {
  const { urlTemplate, zoom, numRows, subdomains } = parameters;
  return urlTemplate.replace(/\{(z|x|y|-y|s)\}/g, (_, key: string) => {
    switch (key) {
      case "z":
        return `${zoom}`;
      case "x":
        return `${x}`;
      case "y":
        return `${y}`;
      case "-y":
        return `${numRows - 1 - y}`;
      case "s":
        return subdomains.length === 0
          ? ""
          : subdomains[(x + y) % subdomains.length];
    }
    return "";
  });
}
