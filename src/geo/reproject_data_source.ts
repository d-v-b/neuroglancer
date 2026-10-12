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
 * @file Reprojection of georeferenced data sources into the display CRS.
 */

import type { CoordinateSpaceTransform } from "#src/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type { DataSource, DataSubsourceEntry } from "#src/datasource/index.js";
import type { Crs } from "#src/geo/crs.js";
import { getCrs, isDisplayCrsUnitSupported } from "#src/geo/crs.js";
import { GEO_DIMENSION_NAMES } from "#src/geo/display_crs.js";
import type { Affine2d, GeoWarpSpec } from "#src/geo/source_warp.js";
import {
  computeGeoWarpSpec,
  computeWarpedBounds,
  getMultiscaleGeoWarp,
} from "#src/geo/source_warp.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";

/**
 * Multiscale volume source that attaches a geospatial warp to each of the single-resolution
 * sources of a base multiscale source.
 */
export class ReprojectedMultiscaleVolumeChunkSource extends MultiscaleVolumeChunkSource {
  constructor(
    public base: MultiscaleVolumeChunkSource,
    public geoWarp: GeoWarpSpec,
  ) {
    super(base.chunkManager);
  }

  get dataType() {
    return this.base.dataType;
  }

  get volumeType() {
    return this.base.volumeType;
  }

  get rank() {
    return this.base.rank;
  }

  get defaultShader() {
    return this.base.defaultShader;
  }

  getSources(
    options: VolumeSourceOptions,
  ): SliceViewSingleResolutionSource<VolumeChunkSource>[][] {
    return this.base
      .getSources(options)
      .map((scales) =>
        scales.map((source) => ({ ...source, geoWarp: this.geoWarp })),
      );
  }
}

function findDependentInputDimensions(
  transform: Float64Array,
  rank: number,
  outputDims: readonly number[],
): number[] {
  const stride = rank + 1;
  const result: number[] = [];
  for (let inputDim = 0; inputDim < rank; ++inputDim) {
    for (const outputDim of outputDims) {
      if (transform[inputDim * stride + outputDim] !== 0) {
        result.push(inputDim);
        break;
      }
    }
  }
  return result;
}

export interface ReprojectedDataSourceInfo {
  geoWarp: GeoWarpSpec;
  sourceCrs: Crs;
  displayCrs: Crs;
  /**
   * Identifiers of subsources omitted because they cannot be reprojected (geometric subsources
   * other than volumes and georeferenced annotations, if the reprojection is not the identity).
   */
  droppedSubsources: string[];
}

/**
 * Returns a copy of `dataSource` whose georeferenced model dimensions are expressed in
 * `displayCrs`.
 */
export function reprojectDataSource(
  dataSource: DataSource,
  displayCrs: Crs,
): DataSource & { reprojection: ReprojectedDataSourceInfo } {
  const { geoReference, modelTransform } = dataSource;
  if (geoReference === undefined) {
    throw new Error("Data source is not georeferenced");
  }
  const sourceCrs = getCrs(geoReference.crs);
  if (!isDisplayCrsUnitSupported(displayCrs)) {
    throw new Error(
      `Display CRS ${displayCrs.id} must have units of meters or degrees`,
    );
  }
  const { rank, inputSpace, outputSpace, transform } = modelTransform;
  const stride = rank + 1;
  const outputDims = geoReference.modelDimensions;
  const inputDims = findDependentInputDimensions(transform, rank, outputDims);
  if (inputDims.length !== 2) {
    throw new Error(
      "Georeferenced model dimensions must depend on exactly two source dimensions",
    );
  }
  for (let outputDim = 0; outputDim < rank; ++outputDim) {
    if (outputDims.includes(outputDim)) continue;
    for (const inputDim of inputDims) {
      if (transform[inputDim * stride + outputDim] !== 0) {
        throw new Error(
          "Georeferenced source dimensions must not affect other model dimensions",
        );
      }
    }
  }
  const inputScales = inputSpace.scales;
  const outputScales = outputSpace.scales;

  // Georeferencing transform from multiscale (input voxel) coordinates to source CRS coordinates.
  const [i0, i1] = inputDims;
  const [o0, o1] = outputDims;
  const multiscaleToSource: Affine2d = [
    transform[i0 * stride + o0] * inputScales[i0],
    transform[i0 * stride + o1] * inputScales[i0],
    transform[i1 * stride + o0] * inputScales[i1],
    transform[i1 * stride + o1] * inputScales[i1],
    transform[rank * stride + o0] * outputScales[o0],
    transform[rank * stride + o1] * outputScales[o1],
  ];

  const { lowerBounds, upperBounds } = inputSpace.bounds;
  const lower = [lowerBounds[i0], lowerBounds[i1]];
  const upper = [upperBounds[i0], upperBounds[i1]];
  if (!lower.every(Number.isFinite) || !upper.every(Number.isFinite)) {
    throw new Error("Georeferenced source must have finite bounds");
  }
  const geoWarp = computeGeoWarpSpec(
    sourceCrs,
    displayCrs,
    [i0, i1],
    multiscaleToSource,
    lower,
    upper,
  );
  const [a00, a10, a01, a11, t0, t1] = geoWarp.multiscaleToDisplay;
  const displayScale = Math.sqrt(Math.abs(a00 * a11 - a01 * a10));

  // Affine approximation of the transform to display CRS coordinates.
  const newTransform = new Float64Array(transform);
  newTransform[i0 * stride + o0] = a00 / inputScales[i0];
  newTransform[i0 * stride + o1] = a10 / inputScales[i0];
  newTransform[i1 * stride + o0] = a01 / inputScales[i1];
  newTransform[i1 * stride + o1] = a11 / inputScales[i1];
  newTransform[rank * stride + o0] = t0 / displayScale;
  newTransform[rank * stride + o1] = t1 / displayScale;

  const displayUnit = displayCrs.unit;
  const newOutputUnits = Array.from(outputSpace.units);
  const newOutputScales = new Float64Array(outputScales);
  // Convert the scales of vertical dimensions from source CRS units to display CRS units.
  const newInputScales = new Float64Array(inputScales);
  const verticalConversion = sourceCrs.metersPerUnit / displayCrs.metersPerUnit;
  for (const { modelDimension } of geoReference.verticalDimensions ?? []) {
    const inputDims = findDependentInputDimensions(transform, rank, [
      modelDimension,
    ]);
    newOutputScales[modelDimension] *= verticalConversion;
    for (const inputDim of inputDims) {
      newInputScales[inputDim] *= verticalConversion;
    }
  }
  newOutputUnits[o0] = newOutputUnits[o1] = displayUnit;
  newOutputScales[o0] = newOutputScales[o1] = displayScale;
  // Georeferenced dimensions of all sources are named consistently, such that they map to the
  // same global dimensions.
  const newOutputNames = Array.from(outputSpace.names);
  for (let i = 0; i < rank; ++i) {
    if (i === o0 || i === o1) continue;
    const name = newOutputNames[i];
    if (name === GEO_DIMENSION_NAMES[0] || name === GEO_DIMENSION_NAMES[1]) {
      newOutputNames[i] = `${name}_source`;
    }
  }
  newOutputNames[o0] = GEO_DIMENSION_NAMES[0];
  newOutputNames[o1] = GEO_DIMENSION_NAMES[1];
  const newOutputSpace = makeCoordinateSpace({
    valid: outputSpace.valid,
    names: newOutputNames,
    units: newOutputUnits,
    scales: newOutputScales,
    coordinateArrays: outputSpace.coordinateArrays,
  });

  // Replace the input bounding box with the bounds of the warped source, such that the bounds of
  // the model space computed from the affine approximation enclose the reprojected source.
  const multiscaleWarp = getMultiscaleGeoWarp(geoWarp);
  const warpedBounds = computeWarpedBounds(multiscaleWarp, lower, upper);
  const newLower = new Float64Array(lowerBounds);
  const newUpper = new Float64Array(upperBounds);
  if (warpedBounds !== undefined) {
    newLower[i0] = warpedBounds.lower[0];
    newLower[i1] = warpedBounds.lower[1];
    newUpper[i0] = warpedBounds.upper[0];
    newUpper[i1] = warpedBounds.upper[1];
  }
  const newInputSpace = makeCoordinateSpace({
    valid: inputSpace.valid,
    names: inputSpace.names,
    units: inputSpace.units,
    scales: newInputScales,
    ids: inputSpace.ids,
    timestamps: inputSpace.timestamps,
    coordinateArrays: inputSpace.coordinateArrays,
    boundingBoxes: [
      makeIdentityTransformedBoundingBox({
        lowerBounds: newLower,
        upperBounds: newUpper,
      }),
    ],
  });
  const newModelTransform: CoordinateSpaceTransform = {
    rank,
    sourceRank: modelTransform.sourceRank,
    inputSpace: newInputSpace,
    outputSpace: newOutputSpace,
    transform: newTransform,
  };

  const subsources: DataSubsourceEntry[] = [];
  const droppedSubsources: string[] = [];
  for (const entry of dataSource.subsources) {
    const { subsource } = entry;
    if (subsource.geoAnnotations !== undefined) {
      subsources.push({
        ...entry,
        subsource: {
          ...subsource,
          annotation: subsource.geoAnnotations.reproject(multiscaleWarp),
        },
      });
    } else if (subsource.volume !== undefined) {
      subsources.push({
        ...entry,
        subsource: {
          ...subsource,
          volume: new ReprojectedMultiscaleVolumeChunkSource(
            subsource.volume,
            geoWarp,
          ),
        },
      });
    } else if (
      !multiscaleWarp.isIdentity &&
      (subsource.staticAnnotations !== undefined ||
        subsource.annotation !== undefined ||
        subsource.mesh !== undefined ||
        subsource.singleMesh !== undefined)
    ) {
      // Geometric subsources other than volumes are not reprojected.  If the reprojection is the
      // identity, the affine approximation of the model transform is exact, and they are retained.
      droppedSubsources.push(entry.id);
      continue;
    } else {
      subsources.push(entry);
    }
  }

  return {
    ...dataSource,
    modelTransform: newModelTransform,
    subsources,
    geoReference: {
      crs: displayCrs.id,
      modelDimensions: [o0, o1],
      verticalDimensions: geoReference.verticalDimensions,
    },
    reprojection: { geoWarp, sourceCrs, displayCrs, droppedSubsources },
  };
}
