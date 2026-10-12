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
 * @file Data source for GeoJSON point and line features, displayed as annotations.
 *
 * URL syntax: `<kvstore url>|geojson:`, optionally followed by `#<options>`, where options are
 * `&`-separated `key=value` pairs:
 *
 *   - `vertical`: interpretation of the third coordinate of positions: `elevation_m` (default, as
 *     specified by RFC 7946), `depth_km` (default for the USGS earthquake catalog), or `none`.
 *   - `swath`: size, in degrees, of a horizontal voxel (default 1).  When a horizontal dimension
 *     is not a display dimension, features within one voxel of the current position along it are
 *     shown.  (Otherwise, the cross section depth determines the features shown.)
 *   - `exaggeration`: vertical exaggeration (default 1).
 */

import type { Annotation } from "#src/annotation/index.js";
import { AnnotationSource, AnnotationType } from "#src/annotation/index.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/coordinate_transform.js";
import type {
  GeoJsonVerticalCoordinate,
  ParsedGeoJson,
} from "#src/datasource/geojson/parse.js";
import {
  inferVerticalCoordinate,
  parseGeoJson,
} from "#src/datasource/geojson/parse.js";
import type {
  DataSource,
  GetKvStoreBasedDataSourceOptions,
  KvStoreBasedDataSourceProvider,
} from "#src/datasource/index.js";
import { TransformStatus } from "#src/geo/transform.js";
import type { Warp2d } from "#src/geo/warp_mesh.js";
import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { parseUrlSuffix } from "#src/kvstore/url.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

const METERS_PER_DEGREE = (Math.PI / 180) * 6378137;

/**
 * Vertical levels of GeoJSON data sources: the vertical model coordinate is
 * `(elevation - VERTICAL_ORIGIN_METERS) / VERTICAL_VOXEL_METERS`.  The levels are the same for all
 * GeoJSON data sources, such that they share a common vertical dimension, and cover the depths of
 * earthquakes.  Features without a vertical coordinate are placed at sea level.
 */
const VERTICAL_VOXEL_METERS = 1e5;
const VERTICAL_ORIGIN_METERS = -1e6;
const NUM_VERTICAL_LEVELS = 11;

export const GEOJSON_VERTICAL_ELEVATIONS = Array.from(
  { length: NUM_VERTICAL_LEVELS },
  (_, i) => VERTICAL_ORIGIN_METERS + (i + 0.5) * VERTICAL_VOXEL_METERS,
);

export function elevationToGeoJsonVerticalCoordinate(elevation: number) {
  return (elevation - VERTICAL_ORIGIN_METERS) / VERTICAL_VOXEL_METERS;
}

/**
 * Maximum length in degrees of line segments after densification, when reprojected by a
 * non-identity warp.
 */
const MAX_SEGMENT_DEGREES = 0.5;

export interface GeoJsonOptions {
  vertical: GeoJsonVerticalCoordinate | undefined;
  swath: number;
  exaggeration: number;
}

export function parseGeoJsonOptions(
  fragment: string | undefined,
): GeoJsonOptions {
  const options: GeoJsonOptions = {
    vertical: undefined,
    swath: 1,
    exaggeration: 1,
  };
  if (!fragment) return options;
  const params = new URLSearchParams(fragment);
  for (const [key, value] of params) {
    switch (key) {
      case "vertical":
        if (
          value !== "elevation_m" &&
          value !== "depth_km" &&
          value !== "none"
        ) {
          throw new Error(
            `Invalid GeoJSON vertical option: ${JSON.stringify(value)}`,
          );
        }
        options.vertical = value;
        break;
      case "swath":
      case "exaggeration": {
        const x = Number(value);
        if (!(x > 0) || !Number.isFinite(x)) {
          throw new Error(
            `Invalid GeoJSON ${key} option: ${JSON.stringify(value)}`,
          );
        }
        options[key] = x;
        break;
      }
      default:
        throw new Error(`Unsupported GeoJSON option: ${JSON.stringify(key)}`);
    }
  }
  return options;
}

/**
 * Annotation source for GeoJSON features, with an optional default annotation shader.
 */
export class GeoJsonAnnotationSource extends AnnotationSource {
  defaultShader: string | undefined;
}

/**
 * Returns a default annotation shader for GeoJSON features.
 */
export function getGeoJsonDefaultShader(parsed: ParsedGeoJson): string {
  const identifiers = new Set(parsed.properties.map((p) => p.identifier));
  const lines: string[] = [];
  const controls: string[] = [];
  if (parsed.hasVertical && identifiers.has("depth_km")) {
    const maxDepth = Math.max(
      10,
      Math.ceil(-parsed.elevationRange[0] / 1000 / 10) * 10,
    );
    controls.push(
      `#uicontrol float maxDepth slider(min=10, max=${Math.max(maxDepth, 700)}, default=${maxDepth}, step=10)`,
    );
    lines.push(
      "  // Color points by depth: shallow red, deep blue.",
      "  float depth = prop_depth_km();",
      "  vec3 color = isnan(depth) ? vec3(1.0, 0.55, 0.1) : colormapJet(1.0 - clamp(depth / maxDepth, 0.0, 1.0));",
    );
  } else {
    lines.push("  vec3 color = vec3(1.0, 0.55, 0.1);");
  }
  if (identifiers.has("mag")) {
    controls.push(
      "#uicontrol float markerScale slider(min=0.25, max=4, default=1, step=0.05)",
    );
    lines.push(
      "  // Size points by magnitude.",
      "  setPointMarkerSize(markerScale * (3.0 + 3.0 * max(0.0, prop_mag() - 4.0)));",
    );
  }
  lines.push(
    "  setPointMarkerColor(color);",
    "  setPointMarkerBorderColor(vec4(0.0, 0.0, 0.0, 0.6));",
    "  setLineColor(color);",
    "  setLineWidth(2.0);",
    "  setPolyLineColor(color);",
    "  setPolyLineWidth(2.0);",
    "  setPolyEndpointMarkerSize(0.0, 0.0);",
  );
  return `${controls.join("\n")}${controls.length ? "\n" : ""}void main() {\n${lines.join("\n")}\n}\n`;
}

/**
 * Builds the annotation source for parsed GeoJSON features.
 *
 * @param warp If specified, maps the horizontal model coordinates `(lon / swath, lat / swath)` to
 *     the coordinates in which the annotations are expressed (e.g. after reprojection).  Line
 *     segments are densified such that they follow curves.
 */
export function makeGeoJsonAnnotationSource(
  parsed: ParsedGeoJson,
  options: GeoJsonOptions,
  warp: (Warp2d & { isIdentity?: boolean }) | undefined,
): GeoJsonAnnotationSource {
  const rank = 3;
  const source = new GeoJsonAnnotationSource(
    rank,
    [],
    parsed.properties.map(({ identifier, description }) => ({
      type: "float32" as const,
      identifier,
      description,
      default: 0,
    })),
  );
  source.readonly = true;
  source.defaultShader = getGeoJsonDefaultShader(parsed);
  const { swath } = options;
  const out = new Float64Array(2);
  const toModel = (lon: number, lat: number, elevation: number) => {
    let x = lon / swath;
    let y = lat / swath;
    if (warp !== undefined) {
      if (warp.forward(x, y, out) === TransformStatus.INVALID) return undefined;
      x = out[0];
      y = out[1];
    }
    return Float32Array.of(
      x,
      y,
      elevationToGeoJsonVerticalCoordinate(
        Number.isNaN(elevation) ? 0 : elevation,
      ),
    );
  };
  const densify = warp !== undefined && !warp.isIdentity;
  // Annotation identifiers are derived from the feature (and part) identifiers, such that they
  // do not depend on the warp.
  const annotations: Annotation[] = [];
  for (const point of parsed.points) {
    const p = toModel(point.lon, point.lat, point.elevation ?? Number.NaN);
    if (p === undefined) continue;
    annotations.push({
      type: AnnotationType.POINT,
      id: point.id,
      point: p,
      properties: point.properties,
      description: point.description,
    });
  }
  for (const lineString of parsed.lineStrings) {
    const { positions } = lineString;
    // Split the line string into contiguous runs of valid points.  The first run has the
    // identifier of the line string; subsequent runs have a `.<run index>` suffix.
    let run: Float32Array[] = [];
    let runIndex = 0;
    const flush = () => {
      if (run.length >= 2) {
        const index = runIndex++;
        annotations.push({
          type: AnnotationType.POLYLINE,
          id: index === 0 ? lineString.id : `${lineString.id}.${index}`,
          points: run,
          properties: lineString.properties,
          description: lineString.description,
        });
      }
      run = [];
    };
    const addPosition = (lon: number, lat: number, elevation: number) => {
      const p = toModel(lon, lat, elevation);
      if (p === undefined) {
        flush();
      } else {
        run.push(p);
      }
    };
    for (let i = 0; i < positions.length; i += 3) {
      const lon = positions[i];
      const lat = positions[i + 1];
      const elevation = positions[i + 2];
      if (densify && i > 0) {
        const lon0 = positions[i - 3];
        const lat0 = positions[i - 2];
        const elevation0 = positions[i - 1];
        const steps = Math.ceil(
          Math.max(Math.abs(lon - lon0), Math.abs(lat - lat0)) /
            MAX_SEGMENT_DEGREES,
        );
        for (let s = 1; s < steps; ++s) {
          const t = s / steps;
          addPosition(
            lon0 + t * (lon - lon0),
            lat0 + t * (lat - lat0),
            elevation0 + t * (elevation - elevation0),
          );
        }
      }
      addPosition(lon, lat, elevation);
    }
    flush();
  }
  for (const annotation of annotations) {
    source.add(annotation);
  }
  return source;
}

/**
 * Constructs the data source for parsed GeoJSON features.
 */
export function getGeoJsonDataSource(
  parsed: ParsedGeoJson,
  options: GeoJsonOptions,
): DataSource {
  const { swath, exaggeration } = options;
  const rank = 3;
  // The vertical dimension holds elevation (positive up), such that it increases upward in
  // north-up cross sections.
  const names = ["x", "y", "z"];
  const units = ["deg", "deg", ""];
  // The vertical scale is expressed in degree-equivalent units, as for other georeferenced
  // sources in geographic coordinates (see `GeoReference.verticalDimensions`).
  const verticalScale =
    (VERTICAL_VOXEL_METERS * exaggeration) / METERS_PER_DEGREE;
  const scales = Float64Array.of(swath, swath, verticalScale);
  const [lonMin, latMin, lonMax, latMax] = parsed.bounds;
  const pad = swath;
  const lowerBounds = Float64Array.of(
    Math.max(-180, lonMin - pad) / swath,
    Math.max(-90, latMin - pad) / swath,
    Math.min(0, elevationToGeoJsonVerticalCoordinate(parsed.elevationRange[0])),
  );
  const upperBounds = Float64Array.of(
    Math.min(180, lonMax + pad) / swath,
    Math.min(90, latMax + pad) / swath,
    Math.max(
      GEOJSON_VERTICAL_ELEVATIONS.length,
      elevationToGeoJsonVerticalCoordinate(parsed.elevationRange[1]),
    ),
  );
  const boundingBoxes = [
    makeIdentityTransformedBoundingBox({ lowerBounds, upperBounds }),
  ];
  const inputSpace = makeCoordinateSpace({
    names,
    units,
    scales,
    boundingBoxes,
  });
  const outputSpace = makeCoordinateSpace({ names, units, scales });
  const transform = new Float64Array((rank + 1) ** 2);
  for (let i = 0; i <= rank; ++i) transform[i * (rank + 2)] = 1;
  return {
    modelTransform: {
      rank,
      sourceRank: rank,
      inputSpace,
      outputSpace,
      transform,
    },
    subsources: [
      {
        id: "default",
        default: true,
        subsource: {
          annotation: makeGeoJsonAnnotationSource(parsed, options, undefined),
          geoAnnotations: {
            reproject: (warp) =>
              makeGeoJsonAnnotationSource(parsed, options, warp),
          },
        },
      },
    ],
    geoReference: {
      crs: "EPSG:4326",
      modelDimensions: [0, 1],
      verticalDimensions: [
        { modelDimension: 2, elevations: GEOJSON_VERTICAL_ELEVATIONS },
      ],
    },
  };
}

export class GeoJsonDataSourceProvider
  implements KvStoreBasedDataSourceProvider
{
  get scheme() {
    return "geojson";
  }

  get description() {
    return "GeoJSON points and lines";
  }

  get singleFile() {
    return true;
  }

  get(options: GetKvStoreBasedDataSourceOptions): Promise<DataSource> {
    const { authorityAndPath, query, fragment } = parseUrlSuffix(
      options.url.suffix,
    );
    if (authorityAndPath || query) {
      throw new Error(
        `Invalid URL ${JSON.stringify(options.url.url)}: expected "geojson:" optionally followed by "#<options>"`,
      );
    }
    const geoJsonOptions = parseGeoJsonOptions(fragment);
    const { kvStoreUrl } = options;
    return options.registry.chunkManager.memoize.getAsync(
      { type: "geojson:get", url: kvStoreUrl, options: geoJsonOptions },
      options,
      async (progressOptions): Promise<DataSource> => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Reading GeoJSON from ${kvStoreUrl}`,
        });
        const response =
          await options.registry.sharedKvStoreContext.kvStoreContext.read(
            kvStoreUrl,
            { ...progressOptions, throwIfMissing: true },
          );
        const json = await response.response.json();
        const parsed = parseGeoJson(
          json,
          geoJsonOptions.vertical ?? inferVerticalCoordinate(json),
        );
        return {
          ...getGeoJsonDataSource(parsed, geoJsonOptions),
          canonicalUrl: `${kvStoreUrl}|${options.url.url}`,
        };
      },
    );
  }
}

export async function detectFormat(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  const text = new TextDecoder().decode(options.prefix).trimStart();
  if (!text.startsWith("{")) return [];
  if (/"type"\s*:\s*"(FeatureCollection|Feature)"/.test(text)) {
    return [{ suffix: "geojson:", description: "GeoJSON" }];
  }
  return [];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    // Sufficient for files in which the "type" member appears near the start (e.g. as written by
    // most tools).  Other files may be specified explicitly with the `geojson:` URL scheme.
    prefixLength: 512,
    suffixLength: 0,
    match: detectFormat,
  });
}
