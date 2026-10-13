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
 * @file Global terrain (land elevation and bathymetry), used to raise the surface of the 3-d globe
 * (see `src/sliceview/globe.ts`).
 *
 * Elevations are obtained from Web Mercator tiles in the Terrarium encoding, by default the
 * open Terrain Tiles dataset hosted on AWS (https://registry.opendata.aws/terrain-tiles/), which
 * combines land elevation models with bathymetry.
 */

import { NullarySignal } from "#src/util/signal.js";

/**
 * URL template of Terrarium-encoded elevation tiles.
 */
export const DEFAULT_TERRAIN_URL_TEMPLATE =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const TERRAIN_TILE_SIZE = 256;

/**
 * Maximum zoom level used.  Zoom level 12 has a resolution of about 38 m at the equator.
 */
export const TERRAIN_MAX_ZOOM = 12;

/**
 * Maximum number of decoded tiles retained (each uses 128 KiB).
 */
const MAX_CACHED_TERRAIN_TILES = 256;

const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;

/**
 * Ground resolution in meters per pixel of Web Mercator tiles at zoom level 0 at the equator.
 */
const ZOOM0_METERS_PER_PIXEL = (2 * Math.PI * 6378137) / TERRAIN_TILE_SIZE;

/**
 * Decodes Terrarium-encoded RGBA pixels (`elevation = R * 256 + G + B / 256 - 32768` meters) to
 * elevations rounded to meters.
 */
export function decodeTerrarium(rgba: ArrayLike<number>): Int16Array {
  const n = rgba.length / 4;
  const out = new Int16Array(n);
  for (let i = 0; i < n; ++i) {
    out[i] = Math.round(
      rgba[4 * i] * 256 + rgba[4 * i + 1] + rgba[4 * i + 2] / 256 - 32768,
    );
  }
  return out;
}

/**
 * Returns the continuous Web Mercator tile coordinates `[x, y]` of a geographic position at the
 * specified zoom level (tile `(i, j)` covers `[i, i + 1) x [j, j + 1)`).
 */
export function lonLatToTileCoordinates(
  lon: number,
  lat: number,
  zoom: number,
): [number, number] {
  const n = 2 ** zoom;
  const clampedLat = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, lat),
  );
  const phi = (clampedLat * Math.PI) / 180;
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const x = ((wrappedLon + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
  return [x, Math.max(0, Math.min(n * (1 - 1e-9), y))];
}

/**
 * Chooses the zoom level whose ground resolution at latitude `lat` best matches
 * `metersPerSample`.
 */
export function chooseTerrainZoom(metersPerSample: number, lat: number) {
  const metersPerPixel0 =
    ZOOM0_METERS_PER_PIXEL * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  if (!(metersPerSample > 0)) return TERRAIN_MAX_ZOOM;
  const zoom = Math.round(Math.log2(metersPerPixel0 / metersPerSample));
  return Math.max(0, Math.min(TERRAIN_MAX_ZOOM, zoom));
}

interface TerrainTile {
  elevations: Int16Array | undefined;
  failed: boolean;
}

/**
 * Loads and caches terrain tiles, and samples elevations from them.
 */
export class TerrainSource {
  /**
   * Signaled when a tile has been loaded.
   */
  changed = new NullarySignal();

  private tiles = new Map<string, TerrainTile>();

  constructor(
    public urlTemplate = DEFAULT_TERRAIN_URL_TEMPLATE,
    private fetchTile: (
      url: string,
    ) => Promise<Int16Array> = fetchTerrariumTile,
  ) {}

  private getTile(zoom: number, x: number, y: number) {
    const key = `${zoom}/${x}/${y}`;
    const { tiles } = this;
    let tile = tiles.get(key);
    if (tile !== undefined) {
      // Move to the end to maintain LRU order.
      tiles.delete(key);
      tiles.set(key, tile);
      return tile;
    }
    tile = { elevations: undefined, failed: false };
    tiles.set(key, tile);
    while (tiles.size > MAX_CACHED_TERRAIN_TILES) {
      const oldest = tiles.keys().next().value!;
      tiles.delete(oldest);
    }
    const url = this.urlTemplate
      .replace("{z}", `${zoom}`)
      .replace("{x}", `${x}`)
      .replace("{y}", `${y}`);
    const loadingTile = tile;
    this.fetchTile(url).then(
      (elevations) => {
        loadingTile.elevations = elevations;
        this.changed.dispatch();
      },
      () => {
        loadingTile.failed = true;
      },
    );
    return tile;
  }

  /**
   * Returns the elevation in meters at a geographic position, from the tile at `zoom` if it is
   * loaded, or otherwise from the finest loaded tile at a lower zoom level (requesting the tile at
   * `zoom`).  Returns `undefined` if no tile covering the position is loaded.
   *
   * @param status If specified, `status.exact` is cleared unless the tile at `zoom` was used (or
   *     cannot be loaded).
   */
  sample(
    lon: number,
    lat: number,
    zoom: number,
    status?: { exact: boolean },
  ): number | undefined {
    let requested = false;
    for (let z = zoom; z >= 0; --z) {
      const [tx, ty] = lonLatToTileCoordinates(lon, lat, z);
      const ix = Math.floor(tx);
      const iy = Math.floor(ty);
      let tile: TerrainTile | undefined;
      if (!requested) {
        tile = this.getTile(z, ix, iy);
        requested = true;
        if (tile.elevations === undefined && !tile.failed && status) {
          status.exact = false;
        }
      } else {
        tile = this.tiles.get(`${z}/${ix}/${iy}`);
      }
      const elevations = tile?.elevations;
      if (elevations === undefined) continue;
      return sampleTile(
        elevations,
        (tx - ix) * TERRAIN_TILE_SIZE - 0.5,
        (ty - iy) * TERRAIN_TILE_SIZE - 0.5,
      );
    }
    return undefined;
  }
}

/**
 * Samples a tile with bilinear interpolation at pixel coordinates `(px, py)` (pixel centers at
 * integer coordinates), clamping to the tile.
 */
function sampleTile(elevations: Int16Array, px: number, py: number) {
  const max = TERRAIN_TILE_SIZE - 1;
  const x = Math.max(0, Math.min(max, px));
  const y = Math.max(0, Math.min(max, py));
  const x0 = Math.min(max - 1, Math.floor(x));
  const y0 = Math.min(max - 1, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * TERRAIN_TILE_SIZE + x0;
  const e00 = elevations[i];
  const e10 = elevations[i + 1];
  const e01 = elevations[i + TERRAIN_TILE_SIZE];
  const e11 = elevations[i + TERRAIN_TILE_SIZE + 1];
  return (
    (e00 * (1 - fx) + e10 * fx) * (1 - fy) + (e01 * (1 - fx) + e11 * fx) * fy
  );
}

async function fetchTerrariumTile(url: string): Promise<Int16Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return decodeTerrarium(
      context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    );
  } finally {
    bitmap.close();
  }
}
