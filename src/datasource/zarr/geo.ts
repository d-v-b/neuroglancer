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
 * @file Georeferencing of zarr arrays written by xarray following the CF conventions.
 *
 * An array whose dimensions (from the `_ARRAY_DIMENSIONS` attribute or zarr v3 `dimension_names`)
 * include longitude and latitude dimensions, with regularly-spaced 1-d coordinate arrays of the
 * same names in the parent group, is georeferenced in geographic WGS 84 coordinates.
 */

import { decodeBlosc } from "#src/async_computation/decode_blosc_request.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { DataType } from "#src/util/data_type.js";
import { decodeGzip } from "#src/util/gzip.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

const LONGITUDE_NAMES = ["longitude", "lon", "long", "nav_lon"];
const LATITUDE_NAMES = ["latitude", "lat", "nav_lat"];

export interface CoordinateAxis {
  /**
   * Coordinate of the center of the first element.
   */
  start: number;
  /**
   * Coordinate spacing (may be negative).
   */
  step: number;
}

/**
 * Summary of an array of an xarray dataset, from consolidated metadata.
 */
export interface XarrayArrayInfo {
  shape: number[];
  dims: string[];
  attrs: any;
  dtype: string;
  chunks: number[];
}

export interface XarrayGeoreference {
  crs: string;
  lonDim: number;
  latDim: number;
  lon: CoordinateAxis;
  lat: CoordinateAxis;
  /**
   * Display scale (in degree-equivalent units per level) of vertical dimensions, keyed by
   * dimension index.
   */
  verticalScales: Map<number, number>;
  /**
   * Elevation (in meters, positive up) of the center of each level of vertical dimensions, keyed
   * by dimension index.
   */
  verticalElevations: Map<number, number[]>;
}

const VERTICAL_NAMES = [
  "depth",
  "elevation",
  "altitude",
  "height",
  "lev",
  "level",
  "z",
  "deptht",
  "depthu",
  "depthv",
];

/**
 * Converts vertical coordinate values to elevations (positive up).  Coordinates named `depth*`
 * that are mostly non-negative are interpreted as depths (positive down).
 */
export function getElevations(name: string, values: number[]): number[] {
  const isDepth =
    name.startsWith("depth") &&
    values.filter((x) => x >= 0).length >= values.length / 2;
  return isDepth ? values.map((x) => -x) : values;
}

/**
 * Vertical exaggeration applied to vertical dimensions relative to horizontal distances.
 */
export const DEFAULT_VERTICAL_EXAGGERATION = 100;

const METERS_PER_DEGREE = (Math.PI / 180) * 6378137;

/**
 * Determines whether a coordinate array is regularly spaced, and returns its start and step.
 */
export function getRegularAxis(
  values: ArrayLike<number>,
): CoordinateAxis | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  if (n === 1) return undefined;
  const start = values[0];
  const step = (values[n - 1] - start) / (n - 1);
  if (!(Math.abs(step) > 0) || !Number.isFinite(step)) return undefined;
  // Coordinates are commonly stored as float32; allow for its precision.
  const tolerance = Math.max(
    Math.abs(step) * 1e-2,
    Math.max(Math.abs(start), Math.abs(values[n - 1])) * 1e-6,
  );
  for (let i = 0; i < n; ++i) {
    if (Math.abs(values[i] - (start + i * step)) > tolerance) return undefined;
  }
  return { start, step };
}

interface CoordinateArrayInfo {
  shape: number;
  chunk: number;
  dtype: string;
  littleEndian: boolean;
  compressors: { id: string; [key: string]: unknown }[];
  chunkKey: (index: number) => string;
}

async function readJson(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  options: Partial<ProgressOptions>,
): Promise<any | undefined> {
  const response = await sharedKvStoreContext.kvStoreContext.read(url, options);
  if (response === undefined) return undefined;
  return JSON.parse(await response.response.text());
}

function parseDtype(dtype: string): { dtype: string; littleEndian: boolean } {
  const m = dtype.match(/^([<>|]?)([fiu])([1248])$/);
  if (m === null) throw new Error(`Unsupported coordinate data type: ${dtype}`);
  return { dtype: `${m[2]}${m[3]}`, littleEndian: m[1] !== ">" };
}

async function getCoordinateArrayInfo(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  zarrVersion: 2 | 3,
  options: Partial<ProgressOptions>,
): Promise<CoordinateArrayInfo | undefined> {
  if (zarrVersion === 2) {
    const zarray = await readJson(
      sharedKvStoreContext,
      `${url}.zarray`,
      options,
    );
    if (zarray === undefined || zarray.shape?.length !== 1) return undefined;
    if (zarray.filters != null && zarray.filters.length !== 0) return undefined;
    const { dtype, littleEndian } = parseDtype(zarray.dtype);
    return {
      shape: zarray.shape[0],
      chunk: zarray.chunks[0],
      dtype,
      littleEndian,
      compressors: zarray.compressor == null ? [] : [zarray.compressor],
      chunkKey: (i) => `${i}`,
    };
  }
  const zarrJson = await readJson(
    sharedKvStoreContext,
    `${url}zarr.json`,
    options,
  );
  if (
    zarrJson === undefined ||
    zarrJson.node_type !== "array" ||
    zarrJson.shape?.length !== 1
  ) {
    return undefined;
  }
  const typeMap: Record<string, string> = {
    float32: "f4",
    float64: "f8",
    int32: "i4",
    int64: "i8",
    int16: "i2",
    uint16: "u2",
    uint32: "u4",
  };
  const dtype = typeMap[zarrJson.data_type];
  if (dtype === undefined) return undefined;
  const chunkShape = zarrJson.chunk_grid?.configuration?.chunk_shape;
  if (!Array.isArray(chunkShape)) return undefined;
  let littleEndian = true;
  const compressors: { id: string }[] = [];
  for (const codec of zarrJson.codecs ?? []) {
    switch (codec.name) {
      case "bytes":
        littleEndian = codec.configuration?.endian !== "big";
        break;
      case "gzip":
      case "zstd":
      case "blosc":
        compressors.push({ id: codec.name, ...codec.configuration });
        break;
      default:
        return undefined;
    }
  }
  const encoding = zarrJson.chunk_key_encoding ?? { name: "default" };
  const separator =
    encoding.configuration?.separator ?? (encoding.name === "v2" ? "." : "/");
  const chunkKey =
    encoding.name === "v2"
      ? (i: number) => `${i}`
      : (i: number) => `c${separator}${i}`;
  return {
    shape: zarrJson.shape[0],
    chunk: chunkShape[0],
    dtype,
    littleEndian,
    compressors,
    chunkKey,
  };
}

async function decompress(
  data: Uint8Array<ArrayBuffer>,
  compressor: { id: string },
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const abortSignal = signal ?? new AbortController().signal;
  switch (compressor.id) {
    case "blosc":
      return requestAsyncComputation(
        decodeBlosc,
        abortSignal,
        [data.buffer],
        data,
      );
    case "zstd":
      return requestAsyncComputation(
        decodeZstd,
        abortSignal,
        [data.buffer],
        data,
      );
    case "zlib":
      return new Uint8Array(await decodeGzip(data, "deflate"));
    case "gzip":
      return new Uint8Array(await decodeGzip(data, "gzip"));
  }
  throw new Error(`Unsupported coordinate array compressor: ${compressor.id}`);
}

function decodeNumbers(
  bytes: Uint8Array,
  dtype: string,
  littleEndian: boolean,
  count: number,
): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = Number(dtype[1]);
  const n = Math.min(count, Math.floor(bytes.byteLength / size));
  const values = new Array<number>(n);
  for (let i = 0; i < n; ++i) {
    const offset = i * size;
    switch (dtype) {
      case "f4":
        values[i] = view.getFloat32(offset, littleEndian);
        break;
      case "f8":
        values[i] = view.getFloat64(offset, littleEndian);
        break;
      case "i2":
        values[i] = view.getInt16(offset, littleEndian);
        break;
      case "u2":
        values[i] = view.getUint16(offset, littleEndian);
        break;
      case "i4":
        values[i] = view.getInt32(offset, littleEndian);
        break;
      case "u4":
        values[i] = view.getUint32(offset, littleEndian);
        break;
      case "i8":
        values[i] = Number(view.getBigInt64(offset, littleEndian));
        break;
      default:
        throw new Error(`Unsupported coordinate data type: ${dtype}`);
    }
  }
  return values;
}

/**
 * Reads a 1-d zarr coordinate array.  Returns `undefined` if it does not exist or is not
 * supported.
 */
export async function readCoordinateArray(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  zarrVersion: 2 | 3,
  options: Partial<ProgressOptions>,
): Promise<number[] | undefined> {
  const info = await getCoordinateArrayInfo(
    sharedKvStoreContext,
    url,
    zarrVersion,
    options,
  );
  if (info === undefined) return undefined;
  const numChunks = Math.ceil(info.shape / info.chunk);
  if (numChunks > 64) return undefined;
  const chunks = await Promise.all(
    Array.from({ length: numChunks }, async (_, i) => {
      const response = await sharedKvStoreContext.kvStoreContext.read(
        `${url}${info.chunkKey(i)}`,
        { ...options, throwIfMissing: true },
      );
      let data = new Uint8Array(await response.response.arrayBuffer());
      for (let j = info.compressors.length; j--; ) {
        data = await decompress(data, info.compressors[j], options.signal);
      }
      const count = Math.min(info.chunk, info.shape - i * info.chunk);
      return decodeNumbers(data, info.dtype, info.littleEndian, count);
    }),
  );
  return chunks.flat();
}

/**
 * Determines the georeferencing of an xarray-style zarr array, or returns `undefined` if the array
 * is not georeferenced.
 *
 * @param arrayUrl URL of the array, ending in `/`.
 */
export async function getXarrayGeoreference(
  sharedKvStoreContext: SharedKvStoreContext,
  arrayUrl: string,
  metadata: ArrayMetadata,
  options: Partial<ProgressOptions>,
): Promise<XarrayGeoreference | undefined> {
  const names = metadata.dimensionNames.map((x) => x?.toLowerCase() ?? "");
  const lonDim = names.findIndex((x) => LONGITUDE_NAMES.includes(x));
  const latDim = names.findIndex((x) => LATITUDE_NAMES.includes(x));
  if (lonDim === -1 || latDim === -1) return undefined;
  const readAxis = async (dim: number) => {
    const name = metadata.dimensionNames[dim]!;
    let url: string;
    try {
      url = sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        arrayUrl,
        `../${name}/`,
      );
    } catch {
      return undefined;
    }
    try {
      const values = await readCoordinateArray(
        sharedKvStoreContext,
        url,
        metadata.zarrVersion,
        options,
      );
      if (values === undefined || values.length !== metadata.shape[dim]) {
        return undefined;
      }
      return getRegularAxis(values);
    } catch {
      return undefined;
    }
  };
  const [lon, lat] = await Promise.all([readAxis(lonDim), readAxis(latDim)]);
  if (lon === undefined || lat === undefined) return undefined;
  // Vertical dimensions are displayed with a scale corresponding to their mean level spacing (in
  // meters), exaggerated relative to horizontal distances.
  const verticalScales = new Map<number, number>();
  const verticalElevations = new Map<number, number[]>();
  await Promise.all(
    names.map(async (name, dim) => {
      if (!VERTICAL_NAMES.includes(name) || metadata.shape[dim] < 2) return;
      const dimName = metadata.dimensionNames[dim]!;
      try {
        const url = sharedKvStoreContext.kvStoreContext.resolveRelativePath(
          arrayUrl,
          `../${dimName}/`,
        );
        const values = await readCoordinateArray(
          sharedKvStoreContext,
          url,
          metadata.zarrVersion,
          options,
        );
        if (values === undefined || values.length < 2) return;
        const meanSpacing =
          Math.abs(values[values.length - 1] - values[0]) / (values.length - 1);
        if (!(meanSpacing > 0)) return;
        verticalScales.set(
          dim,
          (DEFAULT_VERTICAL_EXAGGERATION * meanSpacing) / METERS_PER_DEGREE,
        );
        verticalElevations.set(dim, getElevations(name, values));
      } catch {
        // Ignore vertical coordinates that cannot be read.
      }
    }),
  );
  return {
    crs: "EPSG:4326",
    lonDim,
    latDim,
    lon,
    lat,
    verticalScales,
    verticalElevations,
  };
}

/**
 * Returns the fill value used for missing data, if any, from the CF attributes or the zarr fill
 * value.
 */
export function getMissingValue(metadata: ArrayMetadata): number | undefined {
  const attrs = metadata.userAttributes;
  for (const key of ["_FillValue", "missing_value"]) {
    const value = attrs[key];
    if (typeof value === "number") return value;
  }
  const { fillValue } = metadata;
  if (typeof fillValue === "number" && fillValue !== 0) return fillValue;
  return undefined;
}

/**
 * Returns a default shader for a georeferenced scalar array, mapping the valid range (from CF
 * attributes) to a colormap and rendering missing values as transparent.
 */
function getMissingValueTest(metadata: ArrayMetadata, expr: string) {
  const missing = getMissingValue(metadata);
  let test = `isnan(${expr})`;
  if (missing !== undefined && Number.isFinite(missing)) {
    // Compare with a relative tolerance, since the fill value may not be exactly representable.
    test += ` || abs(${expr} - ${missing.toExponential()}) <= ${Math.abs(missing * 1e-6).toExponential()}`;
  }
  return test;
}

/**
 * Determines whether two variables are the eastward and northward components of a vector field
 * (e.g. ocean currents or winds).
 */
export function isVectorPair(metadata: ArrayMetadata[]): boolean {
  if (metadata.length !== 2) return false;
  const standardNames = metadata.map((m) =>
    String(m.userAttributes.standard_name ?? ""),
  );
  return (
    standardNames[0].startsWith("eastward_") &&
    standardNames[1].startsWith("northward_")
  );
}

/**
 * Returns the default shader for the data variables of an xarray dataset combined as channels.
 */
export function getXarrayDatasetDefaultShader(
  metadata: ArrayMetadata[],
): string | undefined {
  if (metadata.length === 1) return getXarrayDefaultShader(metadata[0]);
  if (metadata.some((m) => m.dataType !== DataType.FLOAT32)) return undefined;
  if (isVectorPair(metadata)) {
    const missingTest = getMissingValueTest(metadata[0], "u");
    return `#uicontrol float maxSpeed slider(min=0.05, max=3, default=1, step=0.05)
#uicontrol bool colorByDirection checkbox(default=false)
vec3 hsvToRgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  float u = getDataValue(0);
  float v = getDataValue(1);
  if (${missingTest}) {
    emitTransparent();
    return;
  }
  float speed = length(vec2(u, v));
  float t = clamp(speed / maxSpeed, 0.0, 1.0);
  if (colorByDirection) {
    // Hue encodes the direction of flow; brightness encodes speed.
    emitRGB(hsvToRgb(vec3(atan(v, u) / 6.28318531 + 0.5, 0.9, t)));
  } else {
    emitRGB(colormapCubehelix(t));
  }
}
`;
  }
  return getXarrayDefaultShader(metadata[0], "0");
}

export function getXarrayDefaultShader(
  metadata: ArrayMetadata,
  channel = "",
): string | undefined {
  if (metadata.dataType !== DataType.FLOAT32) return undefined;
  const attrs = metadata.userAttributes;
  let range: [number, number] | undefined;
  const validMin = attrs.valid_min;
  const validMax = attrs.valid_max;
  const validRange = attrs.valid_range;
  if (typeof validMin === "number" && typeof validMax === "number") {
    range = [validMin, validMax];
  } else if (
    Array.isArray(validRange) &&
    validRange.length === 2 &&
    validRange.every((x) => typeof x === "number")
  ) {
    range = [validRange[0], validRange[1]];
  }
  const parameters: string[] = [];
  if (range !== undefined) parameters.push(`range=[${range[0]}, ${range[1]}]`);
  if (channel !== "") parameters.push(`channel=${channel}`);
  const parameterString =
    parameters.length === 0 ? "" : `(${parameters.join(", ")})`;
  const missingTest = getMissingValueTest(metadata, "value");
  return `#uicontrol invlerp normalized${parameterString}
void main() {
  float value = getDataValue(${channel});
  if (${missingTest}) {
    emitTransparent();
    return;
  }
  emitRGB(colormapJet(normalized()));
}
`;
}

/**
 * Selects the data variables of an xarray dataset to display.  If `requested` is not specified,
 * selects all data variables with the same dimensions, shape, chunking, and data type as the first
 * data variable.
 */
export function selectXarrayVariables(
  arrays: Map<
    string,
    {
      shape: number[];
      dims: string[];
      attrs: any;
      dtype: string;
      chunks: number[];
    }
  >,
  requested: string[] | undefined,
): string[] {
  const coordinates = new Set<string>();
  for (const [name, array] of arrays) {
    if (array.dims.length === 1 && array.dims[0] === name)
      coordinates.add(name);
    const coordinatesAttr = array.attrs.coordinates;
    if (typeof coordinatesAttr === "string") {
      for (const c of coordinatesAttr.split(/\s+/)) coordinates.add(c);
    }
  }
  const signature = (name: string) => {
    const { shape, dims, dtype, chunks } = arrays.get(name)!;
    return JSON.stringify([shape, dims, dtype, chunks]);
  };
  if (requested !== undefined) {
    for (const name of requested) {
      if (!arrays.has(name)) {
        throw new Error(
          `Variable ${JSON.stringify(name)} not found in dataset`,
        );
      }
    }
    const first = signature(requested[0]);
    for (const name of requested) {
      if (signature(name) !== first) {
        throw new Error(
          `Variables ${JSON.stringify(requested[0])} and ${JSON.stringify(name)} must have the same dimensions, shape, chunks, and data type`,
        );
      }
    }
    return requested;
  }
  const candidates = Array.from(arrays.keys())
    .filter(
      (name) => !coordinates.has(name) && arrays.get(name)!.shape.length >= 2,
    )
    .sort();
  if (candidates.length === 0) {
    throw new Error("Dataset contains no data variables");
  }
  const first = signature(candidates[0]);
  return candidates.filter((name) => signature(name) === first);
}
