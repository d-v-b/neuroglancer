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
