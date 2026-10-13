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
 * @file Conversion of serialized annotations for display on the globe of the perspective panel
 * (see `src/geo/globe.ts`).
 */

import type {
  AnnotationPropertySerializer,
  SerializedAnnotations,
} from "#src/annotation/index.js";
import { AnnotationType } from "#src/annotation/index.js";
import { Endianness, ENDIANNESS } from "#src/util/endian.js";

/**
 * Byte offsets, relative to the start of each instance, of the positions of the annotation types
 * that can be shown on the globe, as a function of the rank.  Bounding boxes and ellipsoids are
 * not shown.
 */
const GLOBE_POSITION_OFFSETS: Partial<
  Record<AnnotationType, (rank: number) => number[]>
> = {
  [AnnotationType.POINT]: () => [0],
  [AnnotationType.LINE]: (rank) => [0, 4 * rank],
  [AnnotationType.POLYLINE]: (rank) => [4, 4 + 4 * rank],
};

/**
 * Indicates whether annotations of the specified type are shown on the globe.
 */
export function isGlobeAnnotationType(type: AnnotationType) {
  return GLOBE_POSITION_OFFSETS[type] !== undefined;
}

export interface GlobeAnnotationConversion {
  /**
   * Transform from model coordinates to the displayed subspace, `rank * 3` column-major.
   */
  renderSubspaceTransform: Float32Array;
  /**
   * Transform from the displayed subspace to the global display coordinates.
   */
  displaySubspaceModelMatrix: ArrayLike<number>;
  /**
   * Global dimension of each display dimension.
   */
  displayDimensionIndices: ArrayLike<number>;
  /**
   * Global position, providing the coordinates of the non-display dimensions.
   */
  globalPosition: ArrayLike<number>;
  globalToEcef(globalPosition: ArrayLike<number>, out: Float64Array): boolean;
}

/**
 * Returns a copy of serialized annotations in which the first three model coordinates of each
 * position are replaced by its ECEF coordinates (meters).  Positions that cannot be converted are
 * replaced by `NaN`.  Requires `rank >= 3`.
 */
export function convertAnnotationsToEcef(
  serialized: SerializedAnnotations,
  propertySerializers: readonly AnnotationPropertySerializer[],
  rank: number,
  conversion: GlobeAnnotationConversion,
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(serialized.data);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isLittleEndian = ENDIANNESS === Endianness.LITTLE;
  const {
    renderSubspaceTransform: subspace,
    displaySubspaceModelMatrix: m,
    displayDimensionIndices,
  } = conversion;
  const globalPosition = Float64Array.from(conversion.globalPosition);
  const model = new Float64Array(rank);
  const ecef = new Float64Array(3);
  for (const type of [
    AnnotationType.POINT,
    AnnotationType.LINE,
    AnnotationType.POLYLINE,
  ]) {
    const count = serialized.typeToSize[type];
    if (count === 0) continue;
    const stride = propertySerializers[type].propertyGroupBytes[0];
    const positionOffsets = GLOBE_POSITION_OFFSETS[type]!(rank);
    const typeOffset = serialized.typeToOffset[type];
    for (let i = 0; i < count; ++i) {
      for (const positionOffset of positionOffsets) {
        const offset = typeOffset + i * stride + positionOffset;
        for (let d = 0; d < rank; ++d) {
          model[d] = dv.getFloat32(offset + 4 * d, isLittleEndian);
        }
        for (let k = 0; k < 3; ++k) {
          let s = 0;
          for (let d = 0; d < rank; ++d) s += subspace[d * 3 + k] * model[d];
          ecef[k] = s;
        }
        for (let k = 0; k < 3; ++k) {
          const globalDim = displayDimensionIndices[k];
          if (globalDim === -1) continue;
          globalPosition[globalDim] =
            m[k] * ecef[0] +
            m[4 + k] * ecef[1] +
            m[8 + k] * ecef[2] +
            m[12 + k];
        }
        const valid = conversion.globalToEcef(globalPosition, ecef);
        for (let k = 0; k < 3; ++k) {
          dv.setFloat32(
            offset + 4 * k,
            valid ? ecef[k] : Number.NaN,
            isLittleEndian,
          );
        }
      }
    }
  }
  return data;
}

/**
 * Returns the transform from model coordinates to the displayed subspace for annotations converted
 * by `convertAnnotationsToEcef`, which selects the first three model coordinates.
 */
export function getGlobeRenderSubspaceTransform(rank: number) {
  const transform = new Float32Array(rank * 3);
  for (let k = 0; k < 3; ++k) transform[k * 3 + k] = 1;
  return transform;
}
