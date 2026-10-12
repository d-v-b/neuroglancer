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
 * @file Latitude/longitude graticule and north arrow for cross sections in a geospatial display.
 */

import type { GeoDisplayInfo } from "#src/geo/geo_view.js";
import { globalToLonLat, lonLatToGlobal } from "#src/geo/geo_view.js";

/**
 * Parameters of the view needed to map between screen and global coordinates.
 */
export interface GraticuleViewParameters {
  /**
   * Size of the viewport in pixels.
   */
  width: number;
  height: number;
  /**
   * Transform from display coordinates to clip coordinates, and its inverse.
   */
  viewProjectionMat: ArrayLike<number>;
  invViewProjectionMat: ArrayLike<number>;
  /**
   * Global dimension corresponding to each display dimension.
   */
  displayDimensionIndices: ArrayLike<number>;
  /**
   * Global position of the center of the view.
   */
  globalPosition: ArrayLike<number>;
}

export interface GraticuleLine {
  /**
   * Screen coordinates `[x0, y0, x1, y1, ...]`; `NaN` coordinates separate disconnected
   * segments.
   */
  points: number[];
  isMeridian: boolean;
  value: number;
}

export interface GraticuleLabel {
  x: number;
  y: number;
  text: string;
  /**
   * Edge of the viewport at which the label is placed.
   */
  edge: "bottom" | "left";
}

export interface Graticule {
  lines: GraticuleLine[];
  labels: GraticuleLabel[];
  latitudeSpacing: number;
  longitudeSpacing: number;
}

const GRATICULE_SPACINGS = [
  90, 45, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01, 0.005, 0.0025,
  0.001, 0.0005, 0.00025, 0.0001, 0.00005, 0.000025, 0.00001,
];

/**
 * Chooses the graticule spacing such that a span is divided into at least `minLines` intervals.
 */
export function chooseGraticuleSpacing(span: number, minLines = 3) {
  for (const spacing of GRATICULE_SPACINGS) {
    if (span / spacing >= minLines) return spacing;
  }
  return GRATICULE_SPACINGS[GRATICULE_SPACINGS.length - 1];
}

function getFractionDigits(spacing: number) {
  for (let digits = 0; digits < 8; ++digits) {
    const scaled = spacing * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return digits;
  }
  return 8;
}

/**
 * Formats a graticule label.
 */
export function formatGraticuleLabel(
  value: number,
  isLatitude: boolean,
  spacing: number,
) {
  if (!isLatitude) {
    value = ((((value + 180) % 360) + 360) % 360) - 180;
    if (Math.abs(Math.abs(value) - 180) < 1e-9) {
      return "180°";
    }
  }
  const digits = getFractionDigits(spacing);
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return "0°";
  const hemisphere = isLatitude
    ? rounded > 0
      ? "N"
      : "S"
    : rounded > 0
      ? "E"
      : "W";
  return `${Math.abs(rounded).toFixed(digits)}°${hemisphere}`;
}

/**
 * Maps between screen and geographic coordinates for a view.
 */
class ScreenMapping {
  private globalPosition: Float64Array;

  constructor(
    public info: GeoDisplayInfo,
    public view: GraticuleViewParameters,
  ) {
    this.globalPosition = Float64Array.from(view.globalPosition);
  }

  /**
   * Converts screen coordinates to geographic coordinates.
   */
  screenToLonLat(sx: number, sy: number, out: Float64Array): boolean {
    const { view, info } = this;
    const m = view.invViewProjectionMat;
    const cx = (2 * sx) / view.width - 1;
    const cy = 1 - (2 * sy) / view.height;
    const position = this.globalPosition;
    const w = m[3] * cx + m[7] * cy + m[15];
    for (let d = 0; d < 3; ++d) {
      const dim = view.displayDimensionIndices[d];
      if (dim === -1) continue;
      position[dim] = (m[d] * cx + m[4 + d] * cy + m[12 + d]) / w;
    }
    return globalToLonLat(info, position, out);
  }

  /**
   * Converts geographic coordinates to screen coordinates.
   */
  lonLatToScreen(lon: number, lat: number, out: Float64Array): boolean {
    const { view, info } = this;
    const position = this.globalPosition;
    if (!lonLatToGlobal(info, lon, lat, position)) return false;
    const m = view.viewProjectionMat;
    const display = [0, 0, 0];
    for (let d = 0; d < 3; ++d) {
      const dim = view.displayDimensionIndices[d];
      display[d] = dim === -1 ? 0 : position[dim];
    }
    const x = m[0] * display[0] + m[4] * display[1] + m[8] * display[2] + m[12];
    const y = m[1] * display[0] + m[5] * display[1] + m[9] * display[2] + m[13];
    const w =
      m[3] * display[0] + m[7] * display[1] + m[11] * display[2] + m[15];
    const sx = ((x / w + 1) / 2) * view.width;
    const sy = ((1 - y / w) / 2) * view.height;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
    out[0] = sx;
    out[1] = sy;
    return true;
  }
}

const SAMPLES_PER_LINE = 96;

/**
 * Computes the graticule lines and labels visible in a view.
 */
export function computeGraticule(
  info: GeoDisplayInfo,
  view: GraticuleViewParameters,
): Graticule | undefined {
  const { width, height } = view;
  if (!(width > 0 && height > 0)) return undefined;
  const mapping = new ScreenMapping(info, view);
  const lonLat = new Float64Array(2);
  const screen = new Float64Array(2);

  // Determine the visible geographic extent by sampling the viewport.
  let lonMin = Infinity;
  let lonMax = -Infinity;
  let latMin = Infinity;
  let latMax = -Infinity;
  const n = 12;
  for (let i = 0; i <= n; ++i) {
    for (let j = 0; j <= n; ++j) {
      if (!mapping.screenToLonLat((i / n) * width, (j / n) * height, lonLat)) {
        continue;
      }
      lonMin = Math.min(lonMin, lonLat[0]);
      lonMax = Math.max(lonMax, lonLat[0]);
      latMin = Math.min(latMin, lonLat[1]);
      latMax = Math.max(latMax, lonLat[1]);
    }
  }
  // Include poles within the viewport.
  for (const pole of [90, -90]) {
    if (
      mapping.lonLatToScreen(0, pole, screen) &&
      screen[0] >= 0 &&
      screen[0] <= width &&
      screen[1] >= 0 &&
      screen[1] <= height
    ) {
      lonMin = -180;
      lonMax = 180;
      latMin = Math.min(latMin, pole);
      latMax = Math.max(latMax, pole);
    }
  }
  if (!(lonMin <= lonMax && latMin <= latMax)) return undefined;
  // Extend the range such that lines cross the edges of the viewport, where they are labeled.
  {
    const latPad = 0.1 * (latMax - latMin);
    const lonPad = 0.1 * (lonMax - lonMin);
    latMin -= latPad;
    latMax += latPad;
    if (lonMax - lonMin < 360) {
      lonMin -= lonPad;
      lonMax += lonPad;
    }
  }
  const maxLatitude = info.crs.maxLatitude;
  latMin = Math.max(latMin, -maxLatitude);
  latMax = Math.min(latMax, maxLatitude);
  const latitudeSpacing = chooseGraticuleSpacing(latMax - latMin);
  const longitudeSpacing = Math.max(
    latitudeSpacing,
    chooseGraticuleSpacing(Math.min(360, lonMax - lonMin)),
  );

  const lines: GraticuleLine[] = [];
  const labels: GraticuleLabel[] = [];
  const maxJump = Math.max(width, height) * 0.5;

  const traceLine = (
    isMeridian: boolean,
    value: number,
    from: number,
    to: number,
  ) => {
    const points: number[] = [];
    let prevX = Number.NaN;
    let prevY = Number.NaN;
    let label: GraticuleLabel | undefined;
    for (let i = 0; i <= SAMPLES_PER_LINE; ++i) {
      const t = from + ((to - from) * i) / SAMPLES_PER_LINE;
      const valid = isMeridian
        ? mapping.lonLatToScreen(value, t, screen)
        : mapping.lonLatToScreen(t, value, screen);
      if (!valid) {
        if (!Number.isNaN(prevX)) points.push(Number.NaN, Number.NaN);
        prevX = prevY = Number.NaN;
        continue;
      }
      const [x, y] = screen;
      if (!Number.isNaN(prevX) && Math.hypot(x - prevX, y - prevY) > maxJump) {
        points.push(Number.NaN, Number.NaN);
        prevX = Number.NaN;
      }
      // Find the crossing with the label edge.
      if (!Number.isNaN(prevX) && label === undefined) {
        if (isMeridian) {
          const edge = height;
          if ((prevY - edge) * (y - edge) <= 0 && prevY !== y) {
            const f = (edge - prevY) / (y - prevY);
            const lx = prevX + f * (x - prevX);
            if (lx >= 0 && lx <= width) {
              label = {
                x: lx,
                y: edge,
                text: formatGraticuleLabel(value, false, longitudeSpacing),
                edge: "bottom",
              };
            }
          }
        } else if (prevX * x <= 0 && prevX !== x) {
          const f = (0 - prevX) / (x - prevX);
          const ly = prevY + f * (y - prevY);
          if (ly >= 0 && ly <= height) {
            label = {
              x: 0,
              y: ly,
              text: formatGraticuleLabel(value, true, latitudeSpacing),
              edge: "left",
            };
          }
        }
      }
      points.push(x, y);
      prevX = x;
      prevY = y;
    }
    if (points.length >= 4) {
      lines.push({ points, isMeridian, value });
      if (label !== undefined) labels.push(label);
    }
  };

  const maxLines = 200;
  for (
    let lon = Math.ceil(lonMin / longitudeSpacing) * longitudeSpacing,
      count = 0;
    lon <= lonMax && count < maxLines;
    lon += longitudeSpacing, ++count
  ) {
    // Avoid drawing a meridian twice at -180 and +180 when the full globe is visible.
    if (lonMax - lonMin >= 360 && lon >= lonMin + 360 - 1e-9) break;
    traceLine(true, lon, latMin, latMax);
  }
  for (
    let lat = Math.ceil(latMin / latitudeSpacing) * latitudeSpacing, count = 0;
    lat <= latMax && count < maxLines;
    lat += latitudeSpacing, ++count
  ) {
    if (Math.abs(Math.abs(lat) - 90) < 1e-9) continue;
    traceLine(false, lat, lonMin, lonMax);
  }
  return { lines, labels, latitudeSpacing, longitudeSpacing };
}

/**
 * Returns the screen direction of north at the center of the view, as an angle in radians
 * measured clockwise from the screen up direction, or `undefined` if it cannot be determined.
 */
export function computeNorthDirection(
  info: GeoDisplayInfo,
  view: GraticuleViewParameters,
): number | undefined {
  const mapping = new ScreenMapping(info, view);
  const lonLat = new Float64Array(2);
  if (!mapping.screenToLonLat(view.width / 2, view.height / 2, lonLat)) {
    return undefined;
  }
  const [lon, lat] = lonLat;
  const a = new Float64Array(2);
  const b = new Float64Array(2);
  const delta = 1e-4;
  const lat0 = Math.min(lat, 90 - 2 * delta);
  if (
    !mapping.lonLatToScreen(lon, lat0, a) ||
    !mapping.lonLatToScreen(lon, lat0 + delta, b)
  ) {
    return undefined;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return undefined;
  return Math.atan2(dx, -dy);
}

export interface GraticuleStyle {
  scaleFactor: number;
  fontName: string;
  drawGraticule: boolean;
  drawNorthArrow: boolean;
}

/**
 * Draws the graticule and north arrow onto a 2-d canvas of size `view.width x view.height`.
 */
export function drawGraticule(
  ctx: CanvasRenderingContext2D,
  info: GeoDisplayInfo,
  view: GraticuleViewParameters,
  style: GraticuleStyle,
) {
  const { scaleFactor } = style;
  ctx.clearRect(0, 0, view.width, view.height);
  if (style.drawGraticule) {
    const graticule = computeGraticule(info, view);
    if (graticule !== undefined) {
      ctx.lineWidth = scaleFactor;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.beginPath();
      for (const { points } of graticule.lines) {
        let penDown = false;
        for (let i = 0; i < points.length; i += 2) {
          const x = points[i];
          const y = points[i + 1];
          if (Number.isNaN(x)) {
            penDown = false;
            continue;
          }
          if (penDown) {
            ctx.lineTo(x, y);
          } else {
            ctx.moveTo(x, y);
            penDown = true;
          }
        }
      }
      ctx.stroke();
      const fontSize = 11 * scaleFactor;
      ctx.font = `${fontSize}px ${style.fontName}`;
      ctx.lineWidth = 3 * scaleFactor;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.fillStyle = "white";
      for (const label of graticule.labels) {
        let x = label.x;
        let y = label.y;
        if (label.edge === "bottom") {
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          y -= 3 * scaleFactor;
          const half = ctx.measureText(label.text).width / 2 + 2 * scaleFactor;
          x = Math.min(view.width - half, Math.max(half, x));
        } else {
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          x += 3 * scaleFactor;
          y = Math.min(view.height - fontSize, Math.max(fontSize, y));
        }
        ctx.strokeText(label.text, x, y);
        ctx.fillText(label.text, x, y);
      }
    }
  }
  if (style.drawNorthArrow) {
    const angle = computeNorthDirection(info, view);
    if (angle !== undefined) {
      const size = 14 * scaleFactor;
      const cx = view.width - 2.2 * size;
      const cy = view.height - 2.6 * size;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(0.55 * size, 0.7 * size);
      ctx.lineTo(0, 0.35 * size);
      ctx.lineTo(-0.55 * size, 0.7 * size);
      ctx.closePath();
      ctx.fillStyle = "white";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.lineWidth = 1.5 * scaleFactor;
      ctx.stroke();
      ctx.fill();
      ctx.font = `bold ${11 * scaleFactor}px ${style.fontName}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 3 * scaleFactor;
      ctx.strokeText("N", 0, -size - 2 * scaleFactor);
      ctx.fillText("N", 0, -size - 2 * scaleFactor);
      ctx.restore();
    }
  }
}
