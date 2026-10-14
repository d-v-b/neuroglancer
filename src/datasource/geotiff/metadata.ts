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
 * @file Interpretation of TIFF metadata independent of rendering.
 */

import type { TiffFile, TiffImage } from "#src/datasource/geotiff/tiff.js";
import { DataType } from "#src/util/data_type.js";

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

/**
 * Aligns the resolution levels of the bands of a multi-file image (e.g. the bands of a Sentinel-2
 * scene, stored as separate files with different resolutions): the levels are those of the band
 * with the coarsest full-resolution image (the reference band), and each band contributes its
 * image of the same size (to within a pixel, as overview sizes are rounded) at each level.  Levels
 * at which a band has no such image are omitted.
 *
 * @param bandScales For each band, its images ordered by decreasing resolution (see
 *     `getTiffScales`).
 * @returns The index of the reference band, and for each level, the image of each band.
 */
export function alignGeoTiffBands(bandScales: TiffImage[][]): {
  reference: number;
  levels: TiffImage[][];
} {
  let reference = 0;
  for (let i = 1; i < bandScales.length; ++i) {
    if (bandScales[i][0].width < bandScales[reference][0].width) reference = i;
  }
  const levels: TiffImage[][] = [];
  for (const image of bandScales[reference]) {
    const level: TiffImage[] = [];
    for (const scales of bandScales) {
      const match = scales.find(
        (other) =>
          Math.abs(other.width - image.width) <= 1 &&
          Math.abs(other.height - image.height) <= 1,
      );
      if (match === undefined) break;
      level.push(match);
    }
    if (level.length !== bandScales.length) {
      if (levels.length === 0) {
        throw new Error(
          `Bands have no images of matching size (${image.width}x${image.height})`,
        );
      }
      continue;
    }
    levels.push(level);
  }
  return { reference, levels };
}

/**
 * Returns the URL of a band file specified relative to the URL of the first band (or absolute).
 */
export function resolveGeoTiffBandUrl(baseUrl: string, band: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(band)) return band;
  return baseUrl.replace(/[^/]*$/, band);
}

/**
 * Returns the name of a band file: its file name without the extension.
 */
export function getGeoTiffBandName(url: string) {
  const name = url.replace(/\/+$/, "").replace(/^.*\//, "");
  return name.replace(/\.[^.]*$/, "") || name;
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
