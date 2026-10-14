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
 * @file Viewer-level display coordinate reference system.
 */

import type {
  CoordinateSpaceTransform,
  CoordinateTransformSpecification,
} from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { Crs } from "#src/geo/crs.js";
import { getCrs, isDisplayCrsUnitSupported } from "#src/geo/crs.js";
import { TrackableValue } from "#src/trackable_value.js";
import { verifyString } from "#src/util/json.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Names of the model dimensions holding display CRS x (easting/longitude) and y
 * (northing/latitude) coordinates of reprojected data sources, and of the corresponding global
 * dimensions.
 */
export const GEO_DIMENSION_NAMES: readonly [string, string] = ["x", "y"];

/**
 * CRS adopted as the display CRS when the first georeferenced data source has a CRS whose units
 * are not supported for display (see `isDisplayCrsUnitSupported`).
 */
export const FALLBACK_DISPLAY_CRS = "EPSG:4326";

/**
 * Resolves a display CRS specification.
 *
 * @throws Error if the CRS is not supported, or its units are not supported for display.
 */
export function getDisplayCrs(specification: string): Crs {
  const crs = getCrs(specification);
  if (!isDisplayCrsUnitSupported(crs)) {
    throw new Error(
      `Unsupported display CRS units ${JSON.stringify(crs.unit)}: the display CRS must have units of metres or degrees`,
    );
  }
  return crs;
}

function validateCrsSpecification(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  const s = verifyString(x);
  return getDisplayCrs(s).id;
}

interface VerticalAxisRegistration {
  elevations: number[];
  refCount: number;
}

function elevationsEqual(a: readonly number[], b: readonly number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Display CRS of the viewer, stored in the `"crs"` property of the viewer state.
 *
 * Georeferenced data sources are reprojected into this CRS.  If unspecified, it is set to the CRS
 * of the first georeferenced data source that is loaded (or to `FALLBACK_DISPLAY_CRS` if the units
 * of that CRS are not supported for display); such an adopted CRS is cleared again when the last
 * georeferenced data source is unloaded.
 */
export class TrackableDisplayCrs extends TrackableValue<string | undefined> {
  /**
   * Indicates that the current value was adopted from a data source (or kept when restoring a
   * state without a display CRS), rather than specified explicitly.
   */
  adopted = false;

  get value() {
    return this.value_;
  }

  set value(value: string | undefined) {
    this.adopted = false;
    super.value = value;
  }

  /**
   * Names of the global dimensions holding display CRS x and y coordinates.
   */
  get dimensionNames(): readonly [string, string] {
    return GEO_DIMENSION_NAMES;
  }

  /**
   * Elevations (in meters, positive up) of the levels of vertical global dimensions, keyed by
   * dimension name, as reported by georeferenced data sources.  If several data sources report
   * different elevations for the same dimension name, the most recently registered one is used.
   */
  verticalAxes = new Map<string, number[]>();
  verticalAxesChanged = new NullarySignal();

  private verticalAxisRegistrations = new Map<
    string,
    VerticalAxisRegistration[]
  >();

  /**
   * Number of georeferenced data sources currently loaded.  Geospatial navigation and overlays
   * are only enabled while this is non-zero.
   */
  numGeoSources = 0;
  numGeoSourcesChanged = new NullarySignal();

  /**
   * Indicates that a georeferenced data source is loaded.  Returns a function that must be called
   * when it is unloaded.
   */
  retainGeoSource() {
    ++this.numGeoSources;
    this.numGeoSourcesChanged.dispatch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      --this.numGeoSources;
      this.numGeoSourcesChanged.dispatch();
      if (this.numGeoSources === 0 && this.adopted) {
        this.value = undefined;
      }
    };
  }

  /**
   * Registers the elevations of the levels of a vertical dimension.  Returns a function that must
   * be called when the data source is unloaded.
   */
  registerVerticalAxis(name: string, elevations: number[]): () => void {
    let registrations = this.verticalAxisRegistrations.get(name);
    if (registrations === undefined) {
      registrations = [];
      this.verticalAxisRegistrations.set(name, registrations);
    }
    let registration = registrations.find((r) =>
      elevationsEqual(r.elevations, elevations),
    );
    if (registration === undefined) {
      if (registrations.length !== 0) {
        console.warn(
          `Georeferenced data sources specify different elevations for vertical dimension ${JSON.stringify(name)}; using the most recently loaded one`,
        );
      }
      registration = { elevations, refCount: 0 };
    } else {
      registrations.splice(registrations.indexOf(registration), 1);
    }
    ++registration.refCount;
    registrations.push(registration);
    this.updateVerticalAxis(name);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--registration.refCount === 0) {
        registrations.splice(registrations.indexOf(registration), 1);
        if (registrations.length === 0) {
          this.verticalAxisRegistrations.delete(name);
        }
        this.updateVerticalAxis(name);
      }
    };
  }

  private updateVerticalAxis(name: string) {
    const registrations = this.verticalAxisRegistrations.get(name);
    const elevations = registrations?.[registrations.length - 1].elevations;
    if (this.verticalAxes.get(name) === elevations) return;
    if (elevations === undefined) {
      this.verticalAxes.delete(name);
    } else {
      this.verticalAxes.set(name, elevations);
    }
    this.verticalAxesChanged.dispatch();
  }

  constructor() {
    super(undefined, validateCrsSpecification);
  }

  get crs(): Crs | undefined {
    const { value } = this;
    if (value === undefined) return undefined;
    return getCrs(value);
  }

  /**
   * Returns the display CRS, adopting `sourceCrs` (or `FALLBACK_DISPLAY_CRS`, if the units of
   * `sourceCrs` are not supported for display) if no display CRS has been set.
   */
  getOrAdopt(sourceCrs: string): Crs {
    const { value } = this;
    if (value !== undefined) return getCrs(value);
    let crs = getCrs(sourceCrs);
    if (!isDisplayCrsUnitSupported(crs)) crs = getCrs(FALLBACK_DISPLAY_CRS);
    this.adopted = true;
    super.value = crs.id;
    return crs;
  }

  restoreState(x: unknown) {
    if (x === undefined) {
      // States without a display CRS (e.g. from before geospatial support, or partial state
      // updates) keep the current display CRS, to avoid reprojecting all data sources.  It is then
      // treated as adopted, and cleared once no georeferenced data source remains.
      if (this.value_ !== undefined) this.adopted = true;
      return;
    }
    super.restoreState(x);
  }

  reset() {
    this.value = undefined;
  }
}

/**
 * Removes the dimensions that depend on the display CRS from a custom transform specification of a
 * reprojected data source, such that it can be applied to the data source reprojected into a
 * different display CRS.
 *
 * Dimensions of the specification are matched to source (input) dimensions by name, as by
 * `WatchableCoordinateSpaceTransform.spec`; removed dimensions take their default transform when
 * the specification is applied, while customizations (names, scales, offsets) of the remaining
 * dimensions are preserved.  Coefficients coupling removed and remaining dimensions are dropped.
 *
 * @param defaultTransform Default model transform of the reprojected data source.
 * @param modelDimensions Model (output) dimensions of `defaultTransform` that depend on the display
 *     CRS: the georeferenced dimensions, and vertical dimensions (whose scales are relative to the
 *     display CRS units).
 */
export function stripDisplayCrsDimensionsFromTransformSpecification(
  spec: CoordinateTransformSpecification,
  defaultTransform: CoordinateSpaceTransform,
  modelDimensions: readonly number[],
): CoordinateTransformSpecification {
  const {
    rank: defaultRank,
    sourceRank: defaultSourceRank,
    transform: defaultMatrix,
    inputSpace: defaultInputSpace,
  } = defaultTransform;
  const { sourceRank, outputSpace } = spec;
  const rank = outputSpace.rank;
  const specInputNames = (spec.inputSpace ?? defaultInputSpace).names;
  const removed = new Set<number>();
  for (let inputDim = 0; inputDim < defaultSourceRank; ++inputDim) {
    if (
      !modelDimensions.some(
        (outputDim) =>
          defaultMatrix[inputDim * (defaultRank + 1) + outputDim] !== 0,
      )
    ) {
      continue;
    }
    const specDim = specInputNames.indexOf(defaultInputSpace.names[inputDim]);
    if (specDim !== -1 && specDim < sourceRank) removed.add(specDim);
  }
  if (removed.size === 0) return spec;
  const keep: number[] = [];
  for (let i = 0; i < rank; ++i) {
    if (!removed.has(i)) keep.push(i);
  }
  const newRank = keep.length;
  const select = <T>(values: ArrayLike<T>) => keep.map((i) => values[i]);
  const newOutputSpace = makeCoordinateSpace({
    names: select(outputSpace.names),
    units: select(outputSpace.units),
    scales: Float64Array.from(select(outputSpace.scales)),
    coordinateArrays: select(outputSpace.coordinateArrays),
  });
  // Since dimensions are removed, the input space must be specified explicitly for the remaining
  // dimensions to be matched by name.
  const inputNames: string[] = [];
  const inputUnits: string[] = [];
  const inputScales: number[] = [];
  const inputCoordinateArrays = [];
  for (const i of keep) {
    // Without an input space, the dimensions of the specification below the source rank
    // correspond to the default input dimensions, and the others are singleton dimensions.
    const source =
      spec.inputSpace ?? (i < sourceRank ? defaultInputSpace : outputSpace);
    inputNames.push(
      spec.inputSpace === undefined && i >= sourceRank
        ? `${i}`
        : specInputNames[i],
    );
    inputUnits.push(source.units[i]);
    inputScales.push(source.scales[i]);
    inputCoordinateArrays.push(source.coordinateArrays[i]);
  }
  const newInputSpace = makeCoordinateSpace({
    names: inputNames,
    units: inputUnits,
    scales: Float64Array.from(inputScales),
    coordinateArrays: inputCoordinateArrays,
  });
  let newTransform: Float64Array | undefined;
  const { transform } = spec;
  if (transform !== undefined) {
    newTransform = new Float64Array((newRank + 1) ** 2);
    const indices = [...keep, rank];
    for (let col = 0; col <= newRank; ++col) {
      for (let row = 0; row <= newRank; ++row) {
        newTransform[col * (newRank + 1) + row] =
          transform[indices[col] * (rank + 1) + indices[row]];
      }
    }
  }
  return {
    sourceRank: sourceRank - removed.size,
    transform: newTransform,
    inputSpace: newInputSpace,
    outputSpace: newOutputSpace,
  };
}
