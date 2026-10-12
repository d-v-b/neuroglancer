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
 * @file Vertical sections through georeferenced volumes: mapping between level coordinates and
 * elevation, and drawing of the Earth's surface (sea level), sky, and depth ticks.
 */

/**
 * Piecewise-linear mapping between the coordinate along a vertical dimension and elevation (in
 * meters, positive up).  Level `i` is centered at coordinate `i + 0.5`; the boundaries of the
 * outermost levels are extrapolated by half a level.
 */
export class VerticalAxis {
  private coordinates: number[] = [];
  private elevations: number[] = [];
  readonly ascending: boolean;

  constructor(levelElevations: readonly number[]) {
    const n = levelElevations.length;
    if (n < 2) {
      throw new Error("Vertical axis requires at least 2 levels");
    }
    const e = levelElevations;
    this.coordinates.push(0);
    this.elevations.push(e[0] - (e[1] - e[0]) / 2);
    for (let i = 0; i < n; ++i) {
      this.coordinates.push(i + 0.5);
      this.elevations.push(e[i]);
    }
    this.coordinates.push(n);
    this.elevations.push(e[n - 1] + (e[n - 1] - e[n - 2]) / 2);
    this.ascending = e[n - 1] > e[0];
  }

  get numLevels() {
    return this.coordinates.length - 2;
  }

  /**
   * Elevation range `[min, max]` covered by the levels (including half-level boundaries).
   */
  get elevationRange(): [number, number] {
    const { elevations } = this;
    const a = elevations[0];
    const b = elevations[elevations.length - 1];
    return [Math.min(a, b), Math.max(a, b)];
  }

  private static interpolate(
    xs: readonly number[],
    ys: readonly number[],
    x: number,
  ) {
    const n = xs.length;
    const increasing = xs[n - 1] > xs[0];
    // Find segment.
    let i = 0;
    while (i < n - 2 && (increasing ? x > xs[i + 1] : x < xs[i + 1])) {
      ++i;
    }
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    return ys[i] + t * (ys[i + 1] - ys[i]);
  }

  elevationToCoordinate(elevation: number) {
    return VerticalAxis.interpolate(
      this.elevations,
      this.coordinates,
      elevation,
    );
  }

  coordinateToElevation(coordinate: number) {
    return VerticalAxis.interpolate(
      this.coordinates,
      this.elevations,
      coordinate,
    );
  }
}

const TICK_ELEVATIONS = [
  -10, -20, -50, -100, -200, -300, -500, -750, -1000, -1500, -2000, -3000,
  -4000, -5000, -6000, -8000, -10000, 1000, 2000, 5000, 10000, -100000, -200000,
  -300000, -400000, -500000, -600000, -700000, -50000, -20000, -150000, -250000,
];

export function formatElevation(elevation: number) {
  const depth = -elevation;
  const value = Math.abs(depth);
  const text = value >= 1000 ? `${value / 1000} km` : `${value} m`;
  return depth < 0 ? `+${text}` : text;
}

/**
 * Parameters of a vertical section view.
 */
export interface VerticalSectionParameters {
  width: number;
  height: number;
  /**
   * Inverse of the transform from display coordinates to clip coordinates.
   */
  invViewProjectionMat: ArrayLike<number>;
  /**
   * Display dimension (0, 1, or 2) corresponding to the vertical dimension.
   */
  verticalDisplayDimension: number;
}

/**
 * Returns the coefficients `[a, b, c]` such that the vertical coordinate at screen position
 * `(sx, sy)` is `a * sx + b * sy + c`.
 */
export function getScreenToVerticalCoordinate(
  view: VerticalSectionParameters,
): [number, number, number] {
  const m = view.invViewProjectionMat;
  const d = view.verticalDisplayDimension;
  // clip x = 2 sx / width - 1, clip y = 1 - 2 sy / height; orthographic, so w = 1.
  const ax = m[d];
  const ay = m[4 + d];
  const c0 = m[12 + d];
  return [(2 * ax) / view.width, (-2 * ay) / view.height, c0 - ax + ay];
}

/**
 * Clips the viewport rectangle to the half-plane `a * x + b * y + c >= 0`.
 */
export function clipViewportToHalfPlane(
  width: number,
  height: number,
  a: number,
  b: number,
  c: number,
): number[] {
  const corners = [0, 0, width, 0, width, height, 0, height];
  const result: number[] = [];
  const f = (x: number, y: number) => a * x + b * y + c;
  for (let i = 0; i < 4; ++i) {
    const x0 = corners[2 * i];
    const y0 = corners[2 * i + 1];
    const j = (i + 1) % 4;
    const x1 = corners[2 * j];
    const y1 = corners[2 * j + 1];
    const f0 = f(x0, y0);
    const f1 = f(x1, y1);
    if (f0 >= 0) result.push(x0, y0);
    if (f0 >= 0 !== f1 >= 0) {
      const t = f0 / (f0 - f1);
      result.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
    }
  }
  return result;
}

/**
 * Returns the endpoints `[x0, y0, x1, y1]` of the segment of the line `a * x + b * y + c = 0`
 * within the viewport, or `undefined`.
 */
export function clipLineToViewport(
  width: number,
  height: number,
  a: number,
  b: number,
  c: number,
): [number, number, number, number] | undefined {
  const points: number[] = [];
  const add = (x: number, y: number) => {
    if (x < -1e-6 || x > width + 1e-6 || y < -1e-6 || y > height + 1e-6) return;
    for (let i = 0; i < points.length; i += 2) {
      if (
        Math.abs(points[i] - x) < 1e-6 &&
        Math.abs(points[i + 1] - y) < 1e-6
      ) {
        return;
      }
    }
    points.push(x, y);
  };
  if (b !== 0) {
    add(0, -c / b);
    add(width, -(a * width + c) / b);
  }
  if (a !== 0) {
    add(-c / a, 0);
    add(-(b * height + c) / a, height);
  }
  if (points.length < 4) return undefined;
  return [points[0], points[1], points[2], points[3]];
}

export interface VerticalSectionStyle {
  scaleFactor: number;
  fontName: string;
}

export const SKY_COLOR = "#36597d";
export const SEA_LEVEL_COLOR = "#4fc3f7";
/**
 * Color of the solid Earth (crust) in vertical sections, as RGB in [0, 1].
 */
export const CRUST_COLOR: [number, number, number] = [0.33, 0.25, 0.19];

/**
 * Draws the sky (above sea level), the sea level line, and depth ticks of a vertical section.
 */
export function drawVerticalSection(
  ctx: CanvasRenderingContext2D,
  axis: VerticalAxis,
  view: VerticalSectionParameters,
  style: VerticalSectionStyle,
) {
  const { width, height } = view;
  const { scaleFactor } = style;
  const [a, b, c] = getScreenToVerticalCoordinate(view);
  if (a === 0 && b === 0) return;
  const seaLevel = axis.elevationToCoordinate(0);
  // Elevation increases with the coordinate if the axis is ascending.
  const sign = axis.ascending ? 1 : -1;
  // Sky: elevation > 0.
  const sky = clipViewportToHalfPlane(
    width,
    height,
    sign * a,
    sign * b,
    sign * (c - seaLevel),
  );
  if (sky.length >= 6) {
    ctx.fillStyle = SKY_COLOR;
    ctx.beginPath();
    ctx.moveTo(sky[0], sky[1]);
    for (let i = 2; i < sky.length; i += 2) ctx.lineTo(sky[i], sky[i + 1]);
    ctx.closePath();
    ctx.fill();
  }
  const fontSize = 11 * scaleFactor;
  ctx.font = `${fontSize}px ${style.fontName}`;
  const drawLabel = (text: string, x: number, y: number) => {
    ctx.lineWidth = 3 * scaleFactor;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fillStyle = "white";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  };
  // Depth ticks.
  const [minElevation, maxElevation] = axis.elevationRange;
  const placedLabels: [number, number][] = [];
  const labelSpacing = 2 * fontSize;
  const horizontal = Math.abs(b) > Math.abs(a);
  const getLabelPosition = (coordinate: number) =>
    horizontal ? -(c - coordinate) / b : -(b * height + c - coordinate) / a;
  // Ticks are not placed within the label of the sea level line.
  const seaLevelPosition = getLabelPosition(seaLevel);
  for (const elevation of TICK_ELEVATIONS) {
    if (elevation < minElevation || elevation > maxElevation) continue;
    const coordinate = axis.elevationToCoordinate(elevation);
    const segment = clipLineToViewport(width, height, a, b, c - coordinate);
    if (segment === undefined) continue;
    // Label position along the left (for horizontal lines) or bottom edge.
    const label = formatElevation(elevation);
    const labelExtent = horizontal
      ? labelSpacing
      : ctx.measureText(label).width + 8 * scaleFactor;
    const position = getLabelPosition(coordinate);
    if (Math.abs(position - seaLevelPosition) < labelExtent) continue;
    if (
      placedLabels.some(
        ([p, extent]) => Math.abs(p - position) < (extent + labelExtent) / 2,
      )
    ) {
      continue;
    }
    placedLabels.push([position, labelExtent]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = scaleFactor;
    ctx.beginPath();
    ctx.moveTo(segment[0], segment[1]);
    ctx.lineTo(segment[2], segment[3]);
    ctx.stroke();
    if (horizontal) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      drawLabel(label, 4 * scaleFactor, position);
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      drawLabel(label, position, height - 4 * scaleFactor);
    }
  }
  // Sea level line.
  const seaLevelSegment = clipLineToViewport(width, height, a, b, c - seaLevel);
  if (seaLevelSegment !== undefined) {
    ctx.strokeStyle = SEA_LEVEL_COLOR;
    ctx.lineWidth = 2 * scaleFactor;
    ctx.beginPath();
    ctx.moveTo(seaLevelSegment[0], seaLevelSegment[1]);
    ctx.lineTo(seaLevelSegment[2], seaLevelSegment[3]);
    ctx.stroke();
    const [x0, y0, x1, y1] = seaLevelSegment;
    const left = x0 <= x1 ? [x0, y0] : [x1, y1];
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    drawLabel(
      "sea level",
      Math.max(left[0], 0) + 4 * scaleFactor,
      left[1] - 3 * scaleFactor,
    );
  }
}
