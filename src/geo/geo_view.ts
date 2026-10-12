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
 * @file Viewer-level state and navigation behavior for geospatial display.
 *
 * When a display CRS is set, the two global dimensions holding display CRS coordinates are
 * identified, and the viewer adapts to the spherical geometry of the Earth:
 *
 *   - Cross sections are oriented north-up, and may only be rotated within the map plane.
 *   - For cylindrical display CRSs, the position wraps around in longitude (the data is repeated in
 *     "world copies" by the slice view) and is clamped in latitude.
 *   - Changing the display CRS preserves the geographic location and ground resolution of the
 *     view.
 *   - Positions can be converted to geographic coordinates, and ground distances computed, for
 *     display in the UI (coordinate readout, scale bar, graticule).
 */

import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { makeCoordinateSpace } from "#src/coordinate_transform.js";
import type { Crs } from "#src/geo/crs.js";
import { getCrs } from "#src/geo/crs.js";
import type { TrackableDisplayCrs } from "#src/geo/display_crs.js";
import {
  GeographicTransform,
  haversineDistance,
  TransformStatus,
} from "#src/geo/transform.js";
import { VerticalAxis } from "#src/geo/vertical.js";
import type { NavigationState } from "#src/navigation_state.js";
import { TrackableBoolean } from "#src/trackable_boolean.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { quat } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

/**
 * Orientation of north-up cross sections: a rotation by 180 degrees about the x axis, such that
 * the y axis (northing) points up on the screen.
 */
export const NORTH_UP_ORIENTATION = quat.fromValues(1, 0, 0, 0);

/**
 * Describes how the display CRS maps to the global coordinate space.
 */
export interface GeoDisplayInfo {
  crs: Crs;
  geographic: GeographicTransform;
  /**
   * Indices of the global dimensions holding display CRS x and y coordinates.
   */
  xDim: number;
  yDim: number;
  /**
   * Display CRS units per global voxel for `xDim` and `yDim`.
   */
  xScale: number;
  yScale: number;
}

/**
 * Determines the geo display information, or returns `undefined` if the global coordinate space
 * does not contain the display CRS dimensions.
 */
export function getGeoDisplayInfo(
  crs: Crs | undefined,
  dimensionNames: readonly [string, string],
  coordinateSpace: CoordinateSpace,
): GeoDisplayInfo | undefined {
  if (crs === undefined || !coordinateSpace.valid) return undefined;
  const { names, scales, units } = coordinateSpace;
  const xDim = names.indexOf(dimensionNames[0]);
  const yDim = names.indexOf(dimensionNames[1]);
  if (xDim === -1 || yDim === -1) return undefined;
  const expectedUnit = crs.unit === "deg" ? "deg" : "m";
  if (units[xDim] !== expectedUnit || units[yDim] !== expectedUnit) {
    return undefined;
  }
  return {
    crs,
    geographic: new GeographicTransform(crs),
    xDim,
    yDim,
    xScale: scales[xDim],
    yScale: scales[yDim],
  };
}

/**
 * Converts a global position to geographic coordinates (degrees).
 */
export function globalToLonLat(
  info: GeoDisplayInfo,
  globalPosition: ArrayLike<number>,
  out: Float64Array | number[],
): boolean {
  return (
    info.geographic.toLonLat(
      globalPosition[info.xDim] * info.xScale,
      globalPosition[info.yDim] * info.yScale,
      out,
    ) !== TransformStatus.INVALID
  );
}

/**
 * Sets the display CRS dimensions of a global position from geographic coordinates (degrees).
 */
export function lonLatToGlobal(
  info: GeoDisplayInfo,
  lon: number,
  lat: number,
  globalPosition: Float32Array | Float64Array,
): boolean {
  const out = new Float64Array(2);
  if (info.geographic.fromLonLat(lon, lat, out) === TransformStatus.INVALID) {
    return false;
  }
  globalPosition[info.xDim] = out[0] / info.xScale;
  globalPosition[info.yDim] = out[1] / info.yScale;
  return true;
}

/**
 * Computes the ground distance in meters corresponding to a displacement in global voxel
 * coordinates at the specified position, using the great-circle distance.
 */
export function groundDistance(
  info: GeoDisplayInfo,
  globalPosition: ArrayLike<number>,
  dx: number,
  dy: number,
): number | undefined {
  const a = new Float64Array(2);
  const b = new Float64Array(2);
  const p = Array.from(globalPosition);
  if (!globalToLonLat(info, p, a)) return undefined;
  p[info.xDim] += dx;
  p[info.yDim] += dy;
  if (!globalToLonLat(info, p, b)) return undefined;
  return haversineDistance(a[0], a[1], b[0], b[1]);
}

const EPSILON_PIXELS = 1;

/**
 * Returns the ground distance per screen pixel along the screen x and y axes at the center of the
 * view.
 *
 * @param invViewMatrix Inverse view matrix of the cross section; columns 0 and 1 give the display
 *     displacement per pixel along the screen axes.
 * @param displayDimensionIndices Global dimension corresponding to each display dimension.
 */
export function getGroundMetersPerPixel(
  info: GeoDisplayInfo,
  globalPosition: ArrayLike<number>,
  invViewMatrix: ArrayLike<number>,
  displayDimensionIndices: ArrayLike<number>,
): [number | undefined, number | undefined] | undefined {
  const result: (number | undefined)[] = [];
  for (let axis = 0; axis < 2; ++axis) {
    let dx = 0;
    let dy = 0;
    let other = 0;
    for (let d = 0; d < 3; ++d) {
      const dim = displayDimensionIndices[d];
      const v = invViewMatrix[axis * 4 + d] * EPSILON_PIXELS;
      if (dim === info.xDim) dx = v;
      else if (dim === info.yDim) dy = v;
      else if (dim !== -1) other += Math.abs(v);
    }
    if (
      (dx === 0 && dy === 0) ||
      other > 1e-6 * (Math.abs(dx) + Math.abs(dy))
    ) {
      // The screen axis is not (purely) horizontal.
      result.push(undefined);
      continue;
    }
    const distance = groundDistance(info, globalPosition, dx, dy);
    result.push(
      distance === undefined || !(distance > 0)
        ? undefined
        : distance / EPSILON_PIXELS,
    );
  }
  if (result[0] === undefined && result[1] === undefined) return undefined;
  return [result[0], result[1]];
}

export type GeoPanelView =
  | { kind: "map" }
  | {
      kind: "vertical";
      axis: VerticalAxis;
      /**
       * Display dimension (0, 1, or 2) of the vertical dimension.
       */
      verticalDisplayDimension: number;
      verticalGlobalDimension: number;
    };

const NORMAL_EPSILON = 1e-3;

/**
 * Factor by which the depth range of map views exceeds the extent of the vertical dimensions.
 */
const MAP_DEPTH_RANGE_MARGIN = 20;

/**
 * Classifies a cross section of a geospatial display as a map view (parallel to the map plane)
 * or a vertical section (containing the vertical axis and a horizontal direction), or returns
 * `undefined` otherwise.
 *
 * @param viewMatrix View matrix of the cross section, mapping display coordinates to view
 *     coordinates (with z normal to the plane).
 */
export function classifyGeoPanelView(
  info: GeoDisplayInfo,
  getVerticalAxis: (globalDim: number) => VerticalAxis | undefined,
  viewMatrix: ArrayLike<number>,
  displayDimensionIndices: ArrayLike<number>,
): GeoPanelView | undefined {
  // Display dimension `d` lies in the cross-section plane if it maps to a view direction with
  // no depth component.  Each axis is normalized separately, since display dimensions may have
  // very different scales (e.g. a vertical dimension relative to degrees).
  const inPlane = (d: number) => {
    const x = viewMatrix[4 * d];
    const y = viewMatrix[4 * d + 1];
    const z = viewMatrix[4 * d + 2];
    const norm = Math.hypot(x, y, z);
    return norm !== 0 && Math.abs(z / norm) < NORMAL_EPSILON;
  };
  let xDisplay = -1;
  let yDisplay = -1;
  for (let d = 0; d < 3; ++d) {
    const dim = displayDimensionIndices[d];
    if (dim === info.xDim) xDisplay = d;
    else if (dim === info.yDim) yDisplay = d;
  }
  if (xDisplay === -1 || yDisplay === -1) return undefined;
  if (inPlane(xDisplay) && inPlane(yDisplay)) return { kind: "map" };
  for (let d = 0; d < 3; ++d) {
    const dim = displayDimensionIndices[d];
    if (dim === -1 || d === xDisplay || d === yDisplay || !inPlane(d)) continue;
    const axis = getVerticalAxis(dim);
    if (axis === undefined) continue;
    return {
      kind: "vertical",
      axis,
      verticalDisplayDimension: d,
      verticalGlobalDimension: dim,
    };
  }
  return undefined;
}

/**
 * Returns the depth range (in view units) of a cross section parallel to the map plane such that
 * it spans all levels of the vertical dimensions, or `undefined` if the cross section is not a map
 * view of a display with vertical dimensions.  This ensures that map views show annotations (e.g.
 * earthquake hypocenters) at all depths.
 *
 * @param viewMatrix Transform from display coordinates to view coordinates.
 */
export function computeMapViewDepthRange(
  info: GeoDisplayInfo,
  getVerticalAxis: (globalDim: number) => VerticalAxis | undefined,
  viewMatrix: ArrayLike<number>,
  displayDimensionIndices: ArrayLike<number>,
  globalPosition: ArrayLike<number>,
): number | undefined {
  const view = classifyGeoPanelView(
    info,
    () => undefined,
    viewMatrix,
    displayDimensionIndices,
  );
  if (view?.kind !== "map") return undefined;
  let depthRange: number | undefined;
  for (let d = 0; d < 3; ++d) {
    const dim = displayDimensionIndices[d];
    if (dim === -1 || dim === info.xDim || dim === info.yDim) continue;
    const axis = getVerticalAxis(dim);
    if (axis === undefined) continue;
    const position = globalPosition[dim];
    const extent = Math.max(
      Math.abs(position),
      Math.abs(axis.numLevels - position),
    );
    // Annotations in cross sections fade with distance from the plane relative to the depth
    // range; a large margin keeps features at all depths nearly opaque.
    const range =
      Math.abs(viewMatrix[4 * d + 2]) * (extent + 1) * MAP_DEPTH_RANGE_MARGIN;
    depthRange = Math.max(depthRange ?? 0, range);
  }
  return depthRange;
}

/**
 * Formats a latitude or longitude in degrees, with a hemisphere suffix.
 */
export function formatLatitudeLongitude(
  value: number,
  isLatitude: boolean,
  fractionDigits = 5,
): string {
  if (!isLatitude) {
    value = ((((value + 180) % 360) + 360) % 360) - 180;
  }
  const hemisphere = isLatitude
    ? value >= 0
      ? "N"
      : "S"
    : value >= 0
      ? "E"
      : "W";
  return `${Math.abs(value).toFixed(fractionDigits)}°${hemisphere}`;
}

/**
 * Restricts an orientation to rotations about the view normal relative to the north-up
 * orientation (swing-twist decomposition).
 */
export function restrictToMapPlane(orientation: quat): boolean {
  const rel = quat.multiply(
    quat.create(),
    quat.invert(quat.create(), NORTH_UP_ORIENTATION),
    orientation,
  );
  // Twist about the z axis.
  let w = rel[3];
  let z = rel[2];
  const norm = Math.hypot(w, z);
  if (norm < 1e-6) {
    w = 1;
    z = 0;
  } else {
    w /= norm;
    z /= norm;
  }
  const twist = quat.fromValues(0, 0, z, w);
  const restricted = quat.multiply(quat.create(), NORTH_UP_ORIENTATION, twist);
  let changed = false;
  for (let i = 0; i < 4; ++i) {
    if (Math.abs(restricted[i] - orientation[i]) > 1e-7) changed = true;
  }
  if (changed) quat.copy(orientation, restricted);
  return changed;
}

/**
 * Wraps the x coordinate (in display CRS units) of a cylindrical CRS into the world centered on
 * the central meridian, and clamps the y coordinate.  Returns `undefined` if unchanged.
 */
export function normalizeCrsPosition(
  crs: Crs,
  x: number,
  y: number,
): [number, number] | undefined {
  const { worldPeriod } = crs;
  let newX = x;
  let newY = y;
  if (worldPeriod !== undefined) {
    const half = worldPeriod / 2;
    const center = crs.isGeographic ? crs.centralMeridian : 0;
    if (x > center + half || x < center - half) {
      newX = x - worldPeriod * Math.round((x - center) / worldPeriod);
    }
    let maxY: number | undefined;
    if (crs.isGeographic) {
      maxY = 90;
    } else if (crs.projectionName === "merc") {
      maxY = half;
    }
    if (maxY !== undefined) {
      newY = Math.max(-maxY, Math.min(maxY, y));
    }
  }
  if (newX === x && newY === y) return undefined;
  return [newX, newY];
}

/**
 * Viewer-level geospatial state.
 */
export class GeoViewState extends RefCounted {
  changed = new NullarySignal();

  /**
   * Whether to draw a latitude/longitude graticule over cross sections.
   */
  showGraticule = new TrackableBoolean(true, true);

  private info_: GeoDisplayInfo | undefined;
  private infoStale = true;

  constructor(
    public displayCrs: TrackableDisplayCrs,
    public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
    public navigationState: NavigationState,
  ) {
    super();
    const invalidate = () => {
      this.infoStale = true;
      this.changed.dispatch();
    };
    this.registerDisposer(displayCrs.changed.add(invalidate));
    this.registerDisposer(displayCrs.verticalAxesChanged.add(invalidate));
    this.registerDisposer(displayCrs.numGeoSourcesChanged.add(invalidate));
    this.registerDisposer(coordinateSpace.changed.add(invalidate));
    this.registerDisposer(
      this.showGraticule.changed.add(this.changed.dispatch),
    );
    this.registerDisposer(
      navigationState.position.changed.add(() => this.handlePositionChanged()),
    );
    const orientation = navigationState.pose.orientation;
    this.registerDisposer(
      orientation.changed.add(() => this.handleOrientationChanged()),
    );
    // Orient north-up when a geospatial display is first established.
    this.registerDisposer(
      this.changed.add(() => this.maybeInitializeOrientation()),
    );
  }

  private verticalAxisCache = new Map<number[], VerticalAxis>();

  /**
   * Returns the vertical axis corresponding to a global dimension, if any.
   */
  getVerticalAxis(globalDim: number): VerticalAxis | undefined {
    const name = this.coordinateSpace.value.names[globalDim];
    if (name === undefined) return undefined;
    const elevations = this.displayCrs.verticalAxes.get(name);
    if (elevations === undefined || elevations.length < 2) return undefined;
    let axis = this.verticalAxisCache.get(elevations);
    if (axis === undefined) {
      axis = new VerticalAxis(elevations);
      this.verticalAxisCache.set(elevations, axis);
    }
    return axis;
  }

  /**
   * Returns the depth range of a map view that spans the vertical dimensions, or `undefined`.  See
   * `computeMapViewDepthRange`.
   */
  getMapViewDepthRange(
    viewMatrix: ArrayLike<number>,
    displayDimensionIndices: ArrayLike<number>,
    globalPosition: ArrayLike<number>,
  ): number | undefined {
    const { info } = this;
    if (info === undefined) return undefined;
    return computeMapViewDepthRange(
      info,
      (dim) => this.getVerticalAxis(dim),
      viewMatrix,
      displayDimensionIndices,
      globalPosition,
    );
  }

  get info(): GeoDisplayInfo | undefined {
    if (this.infoStale) {
      this.infoStale = false;
      this.info_ = getGeoDisplayInfo(
        this.displayCrs.numGeoSources === 0 ? undefined : this.displayCrs.crs,
        this.displayCrs.dimensionNames,
        this.coordinateSpace.value,
      );
    }
    return this.info_;
  }

  private orientationInitialized = false;

  private maybeInitializeOrientation() {
    if (this.orientationInitialized || this.info === undefined) return;
    this.orientationInitialized = true;
    this.handleOrientationChanged();
  }

  private updatingOrientation = false;

  private handleOrientationChanged() {
    if (this.updatingOrientation || this.info === undefined) return;
    const orientation = this.navigationState.pose.orientation;
    this.orientationInitialized = true;
    if (restrictToMapPlane(orientation.orientation)) {
      this.updatingOrientation = true;
      try {
        orientation.changed.dispatch();
      } finally {
        this.updatingOrientation = false;
      }
    }
  }

  private updatingPosition = false;

  private handlePositionChanged() {
    if (this.updatingPosition) return;
    const info = this.info;
    if (info === undefined) return;
    const { position } = this.navigationState;
    const value = position.value;
    if (value.length <= Math.max(info.xDim, info.yDim)) return;
    const normalized = normalizeCrsPosition(
      info.crs,
      value[info.xDim] * info.xScale,
      value[info.yDim] * info.yScale,
    );
    if (normalized === undefined) return;
    const newValue = new Float32Array(value);
    newValue[info.xDim] = normalized[0] / info.xScale;
    newValue[info.yDim] = normalized[1] / info.yScale;
    this.updatingPosition = true;
    try {
      position.value = newValue;
    } finally {
      this.updatingPosition = false;
    }
  }

  /**
   * Returns the geographic coordinates of the center of the view.
   */
  getCenterLonLat(): Float64Array | undefined {
    const info = this.info;
    if (info === undefined) return undefined;
    const out = new Float64Array(2);
    const { position } = this.navigationState;
    if (!position.valid) return undefined;
    if (!globalToLonLat(info, position.value, out)) return undefined;
    return out;
  }

  /**
   * Changes the display CRS, preserving the geographic location and ground resolution of the
   * view.
   */
  setDisplayCrs(specification: string) {
    const newCrs = getCrs(specification);
    const { displayCrs, navigationState } = this;
    if (displayCrs.value === newCrs.id) return;
    const info = this.info;
    const center = this.getCenterLonLat();
    let metersPerPixel: number | undefined;
    if (info !== undefined && center !== undefined) {
      const { zoomFactor } = navigationState;
      const renderInfo = navigationState.displayDimensionRenderInfo.value;
      const unitsPerPixel =
        zoomFactor.value * renderInfo.canonicalVoxelPhysicalSize;
      const distance = groundDistance(
        info,
        navigationState.position.value,
        unitsPerPixel / info.xScale,
        0,
      );
      if (distance !== undefined) metersPerPixel = distance;
    }
    if (info !== undefined) {
      // Convert the units and scales of the display CRS dimensions of the global coordinate space,
      // such that layers reprojected into the new CRS are merged into the same dimensions.
      const space = this.coordinateSpace.value;
      const unit = newCrs.unit === "deg" ? "deg" : "m";
      const units = Array.from(space.units);
      const scales = new Float64Array(space.scales);
      const conversion = info.crs.metersPerUnit / newCrs.metersPerUnit;
      for (const dim of [info.xDim, info.yDim]) {
        units[dim] = unit;
        scales[dim] = space.scales[dim] * conversion;
      }
      // Vertical dimensions are scaled relative to the CRS units to preserve vertical
      // exaggeration.
      for (let dim = 0; dim < space.rank; ++dim) {
        if (this.getVerticalAxis(dim) !== undefined) {
          scales[dim] = space.scales[dim] * conversion;
        }
      }
      (this.coordinateSpace as WatchableValueInterface<CoordinateSpace>).value =
        makeCoordinateSpace({
          valid: space.valid,
          names: space.names,
          ids: space.ids,
          timestamps: space.timestamps,
          units,
          scales,
          boundingBoxes: space.boundingBoxes,
          coordinateArrays: space.coordinateArrays,
        });
    }
    displayCrs.value = newCrs.id;
    const newInfo = this.info;
    if (newInfo === undefined || center === undefined) return;
    const { position } = navigationState;
    const newPosition = new Float32Array(position.value);
    if (lonLatToGlobal(newInfo, center[0], center[1], newPosition)) {
      position.value = newPosition;
    }
    if (metersPerPixel !== undefined) {
      const metersPerUnit = groundDistance(newInfo, newPosition, 1, 0);
      const renderInfo = navigationState.displayDimensionRenderInfo.value;
      if (metersPerUnit !== undefined && metersPerUnit > 0) {
        const unitsPerPixel = (metersPerPixel / metersPerUnit) * newInfo.xScale;
        navigationState.zoomFactor.value =
          unitsPerPixel / renderInfo.canonicalVoxelPhysicalSize;
      }
    }
  }
}
