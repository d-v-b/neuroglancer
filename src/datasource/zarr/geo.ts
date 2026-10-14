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

// CF units of longitude and latitude, normalized by `normalizeDegreeUnits`.
const LONGITUDE_UNITS = ["degreeseast", "degreeeast", "degreese", "degreee"];
const LATITUDE_UNITS = ["degreesnorth", "degreenorth", "degreesn", "degreen"];
const GENERIC_DEGREE_UNITS = ["degrees", "degree", "deg"];

function normalizeDegreeUnits(units: string) {
  return units.toLowerCase().replace(/[\s_]/g, "");
}

/**
 * Determines whether a coordinate (named like a longitude or latitude) holds geographic
 * longitudes or latitudes in degrees, based on its values and CF `units` and `standard_name`
 * attributes.
 *
 * - If `units` is specified, it must be degrees (e.g. `degrees_east` for longitude, `degrees_north`
 *   for latitude, or plain `degrees`).
 * - If `standard_name` is specified, it must be `longitude` or `latitude`, respectively.
 * - Longitudes must be within [-180, 360] and latitudes within [-90, 90].
 */
export function isGeographicCoordinate(
  kind: "longitude" | "latitude",
  values: ArrayLike<number>,
  attrs: Record<string, unknown> = {},
): boolean {
  const { units, standard_name: standardName } = attrs;
  if (standardName !== undefined && standardName !== kind) return false;
  if (units !== undefined) {
    if (typeof units !== "string") return false;
    const normalized = normalizeDegreeUnits(units);
    const allowed = kind === "longitude" ? LONGITUDE_UNITS : LATITUDE_UNITS;
    if (
      !allowed.includes(normalized) &&
      !GENERIC_DEGREE_UNITS.includes(normalized)
    ) {
      return false;
    }
  }
  const [min, max] = kind === "longitude" ? [-180, 360] : [-90, 90];
  const tolerance = 1e-3;
  for (let i = 0; i < values.length; ++i) {
    const x = values[i];
    if (!(x >= min - tolerance && x <= max + tolerance)) return false;
  }
  return true;
}

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
   * Display scale of vertical dimensions, keyed by dimension index, in exaggerated meters per
   * level (converted to display CRS units when the source is reprojected).
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
  "plev",
  "z",
  "deptht",
  "depthu",
  "depthv",
];

/**
 * Vertical coordinate names that imply a length (in meters if no units are specified).
 */
const LENGTH_VERTICAL_NAMES = [
  "depth",
  "elevation",
  "altitude",
  "height",
  "deptht",
  "depthu",
  "depthv",
];

const LENGTH_UNITS: Record<string, number> = {
  m: 1,
  meter: 1,
  meters: 1,
  metre: 1,
  metres: 1,
  km: 1000,
  kilometer: 1000,
  kilometers: 1000,
  kilometre: 1000,
  kilometres: 1000,
  cm: 0.01,
  centimeter: 0.01,
  centimeters: 0.01,
  centimetre: 0.01,
  centimetres: 0.01,
  mm: 0.001,
};

// Pressure units, in pascals.
const PRESSURE_UNITS: Record<string, number> = {
  pa: 1,
  hpa: 100,
  kpa: 1000,
  mbar: 100,
  millibar: 100,
  millibars: 100,
  bar: 1e5,
  bars: 1e5,
};

/**
 * Approximate altitude (in meters) corresponding to a pressure (in pascals), using the barometric
 * formula of the International Standard Atmosphere.
 */
export function pressureToAltitude(pressure: number): number {
  return 44330.8 * (1 - Math.pow(pressure / 101325, 0.190263));
}

/**
 * Converts vertical coordinate values to elevations in meters (positive up), based on the CF
 * `units`, `positive`, `standard_name`, and `axis` attributes of the coordinate.  Returns
 * `undefined` if the coordinate is not a supported vertical coordinate, e.g. if it has unknown
 * units or is a dimensionless (sigma or hybrid) coordinate.
 *
 * - Lengths (m, km, cm, mm) are converted to meters.  Coordinates with `positive: "down"`, or
 *   named `depth*` without a `positive` attribute and mostly non-negative values, are depths.
 *   Coordinates named `depth`, `elevation`, `altitude` or `height` without units are in meters.
 * - Pressures (Pa, hPa, kPa, mbar, bar) are converted to approximate altitudes using the standard
 *   atmosphere.
 */
export function getElevations(
  name: string,
  values: number[],
  attrs: Record<string, unknown> = {},
): number[] | undefined {
  if (values.length === 0 || !values.every(Number.isFinite)) return undefined;
  const { axis, positive, formula_terms: formulaTerms } = attrs;
  const standardName = String(attrs.standard_name ?? "");
  if (axis !== undefined && String(axis).toUpperCase() !== "Z")
    return undefined;
  // Dimensionless (sigma, hybrid, ...) parametric vertical coordinates.
  if (
    formulaTerms !== undefined ||
    /^(atmosphere|ocean)_.*_coordinate$/.test(standardName)
  ) {
    return undefined;
  }
  const units =
    typeof attrs.units === "string" ? attrs.units.trim().toLowerCase() : "";
  const pressureFactor = PRESSURE_UNITS[units];
  if (pressureFactor !== undefined) {
    if (!values.every((x) => x >= 0)) return undefined;
    return values.map((x) => pressureToAltitude(x * pressureFactor));
  }
  let lengthFactor = LENGTH_UNITS[units];
  if (
    lengthFactor === undefined &&
    units === "" &&
    LENGTH_VERTICAL_NAMES.includes(name)
  ) {
    lengthFactor = 1;
  }
  if (lengthFactor === undefined) return undefined;
  let isDepth: boolean;
  const positiveString = String(positive ?? "").toLowerCase();
  if (positiveString === "down") {
    isDepth = true;
  } else if (positiveString === "up") {
    isDepth = false;
  } else {
    isDepth =
      (name.startsWith("depth") || standardName === "depth") &&
      values.filter((x) => x >= 0).length >= values.length / 2;
  }
  const factor = isDepth ? -lengthFactor : lengthFactor;
  return values.map((x) => x * factor);
}

/**
 * Vertical exaggeration applied to vertical dimensions relative to horizontal distances.
 */
export const DEFAULT_VERTICAL_EXAGGERATION = 100;

/**
 * Determines whether a coordinate array is regularly spaced, and returns its start and step.
 *
 * @param bounds CF cell bounds of the coordinate, used to determine the spacing of a single
 *     coordinate.
 */
export function getRegularAxis(
  values: ArrayLike<number>,
  bounds?: ArrayLike<number>,
): CoordinateAxis | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  if (n === 1) {
    // The spacing of a single coordinate is given by its CF cell bounds, if available.
    if (bounds === undefined || bounds.length !== 2) return undefined;
    const step = bounds[1] - bounds[0];
    if (!(Math.abs(step) > 0) || !Number.isFinite(step)) return undefined;
    return { start: values[0], step };
  }
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
  /**
   * Size of the second dimension of 2-d (e.g. CF bounds) arrays, or 1 for 1-d arrays.
   */
  rowSize: number;
  attrs: Record<string, unknown>;
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

/**
 * Coordinate arrays must be 1-d, or 2-d with a single chunk along the second dimension (as for CF
 * bounds arrays).
 */
function isSupportedCoordinateShape(array: {
  shape?: unknown;
  chunks?: unknown;
}): boolean {
  const { shape, chunks } = array;
  if (!Array.isArray(shape) || !Array.isArray(chunks)) return false;
  if (shape.length === 1) return true;
  return shape.length === 2 && chunks[1] === shape[1];
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
    if (zarray === undefined || !isSupportedCoordinateShape(zarray)) {
      return undefined;
    }
    if (zarray.filters != null && zarray.filters.length !== 0) return undefined;
    if (zarray.order === "F" && zarray.shape.length !== 1) return undefined;
    const { dtype, littleEndian } = parseDtype(zarray.dtype);
    let attrs: Record<string, unknown> = {};
    try {
      attrs =
        (await readJson(sharedKvStoreContext, `${url}.zattrs`, options)) ?? {};
    } catch {
      // Ignore invalid attributes.
    }
    return {
      shape: zarray.shape[0],
      chunk: zarray.chunks[0],
      rowSize: zarray.shape[1] ?? 1,
      attrs,
      dtype,
      littleEndian,
      compressors: zarray.compressor == null ? [] : [zarray.compressor],
      chunkKey: (i) =>
        zarray.shape.length === 1
          ? `${i}`
          : `${i}${zarray.dimension_separator ?? "."}0`,
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
    !isSupportedCoordinateShape({
      shape: zarrJson.shape,
      chunks: zarrJson.chunk_grid?.configuration?.chunk_shape,
    })
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
  const suffix = zarrJson.shape.length === 1 ? "" : `${separator}0`;
  const chunkKey =
    encoding.name === "v2"
      ? (i: number) => `${i}${suffix}`
      : (i: number) => `c${separator}${i}${suffix}`;
  return {
    shape: zarrJson.shape[0],
    chunk: chunkShape[0],
    rowSize: zarrJson.shape[1] ?? 1,
    attrs: zarrJson.attributes ?? {},
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

export interface CoordinateArray {
  /**
   * Values (in C order for 2-d arrays), with CF `scale_factor` and `add_offset` applied.
   */
  values: number[];
  attrs: Record<string, unknown>;
}

/**
 * Applies the CF `scale_factor` and `add_offset` attributes to packed values.
 */
export function unpackCfValues(
  values: number[],
  attrs: Record<string, unknown>,
): number[] {
  const { scale, offset } = getCfPacking(attrs);
  if (scale === 1 && offset === 0) return values;
  return values.map((x) => x * scale + offset);
}

/**
 * Returns the CF `scale_factor` and `add_offset` attributes (defaulting to 1 and 0).
 */
export function getCfPacking(attrs: Record<string, unknown>): {
  scale: number;
  offset: number;
} {
  const getNumber = (key: string, defaultValue: number) => {
    let value = attrs[key];
    if (Array.isArray(value) && value.length === 1) value = value[0];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : defaultValue;
  };
  return {
    scale: getNumber("scale_factor", 1),
    offset: getNumber("add_offset", 0),
  };
}

/**
 * Reads a 1-d (or small 2-d) zarr coordinate array.  Returns `undefined` if it does not exist or
 * is not supported.
 */
export async function readCoordinateArray(
  sharedKvStoreContext: SharedKvStoreContext,
  url: string,
  zarrVersion: 2 | 3,
  options: Partial<ProgressOptions>,
): Promise<CoordinateArray | undefined> {
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
      const count =
        Math.min(info.chunk, info.shape - i * info.chunk) * info.rowSize;
      return decodeNumbers(data, info.dtype, info.littleEndian, count);
    }),
  );
  return {
    values: unpackCfValues(chunks.flat(), info.attrs),
    attrs: info.attrs,
  };
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
  const resolveSibling = (name: string) => {
    try {
      return sharedKvStoreContext.kvStoreContext.resolveRelativePath(
        arrayUrl,
        `../${name}/`,
      );
    } catch {
      return undefined;
    }
  };
  const readSibling = async (name: string) => {
    const url = resolveSibling(name);
    if (url === undefined) return undefined;
    try {
      return await readCoordinateArray(
        sharedKvStoreContext,
        url,
        metadata.zarrVersion,
        options,
      );
    } catch {
      return undefined;
    }
  };
  const readAxis = async (dim: number, kind: "longitude" | "latitude") => {
    const coordinate = await readSibling(metadata.dimensionNames[dim]!);
    if (coordinate === undefined) return undefined;
    const { values, attrs } = coordinate;
    if (values.length !== metadata.shape[dim]) return undefined;
    if (!isGeographicCoordinate(kind, values, attrs)) return undefined;
    let bounds: number[] | undefined;
    if (values.length === 1 && typeof attrs.bounds === "string") {
      bounds = (await readSibling(attrs.bounds))?.values;
    }
    return getRegularAxis(values, bounds);
  };
  const [lon, lat] = await Promise.all([
    readAxis(lonDim, "longitude"),
    readAxis(latDim, "latitude"),
  ]);
  if (lon === undefined || lat === undefined) return undefined;
  // Vertical dimensions are displayed with a scale corresponding to their mean level spacing (in
  // meters), exaggerated relative to horizontal distances.
  const verticalScales = new Map<number, number>();
  const verticalElevations = new Map<number, number[]>();
  await Promise.all(
    names.map(async (name, dim) => {
      if (!VERTICAL_NAMES.includes(name) || metadata.shape[dim] < 2) return;
      const coordinate = await readSibling(metadata.dimensionNames[dim]!);
      if (
        coordinate === undefined ||
        coordinate.values.length !== metadata.shape[dim]
      ) {
        return;
      }
      const elevations = getElevations(
        name,
        coordinate.values,
        coordinate.attrs,
      );
      if (elevations === undefined) return;
      const meanSpacing =
        Math.abs(elevations[elevations.length - 1] - elevations[0]) /
        (elevations.length - 1);
      if (!(meanSpacing > 0)) return;
      verticalScales.set(dim, DEFAULT_VERTICAL_EXAGGERATION * meanSpacing);
      verticalElevations.set(dim, elevations);
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
 * Returns a GLSL expression testing whether the float `expr` is a missing value.
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

const SHADER_DATA_TYPES = [
  DataType.FLOAT32,
  DataType.UINT8,
  DataType.INT8,
  DataType.UINT16,
  DataType.INT16,
  DataType.UINT32,
  DataType.INT32,
];

/**
 * Formats a number as a GLSL float literal.
 */
function glslFloat(x: number) {
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/**
 * Returns a default shader for a georeferenced scalar array, mapping the valid range (from CF
 * attributes) to a colormap and rendering missing values as transparent.
 *
 * For packed integer (or float) variables with CF `scale_factor`/`add_offset` attributes, the
 * shader computes the unpacked value; as in CF, the valid range and fill value are in packed
 * units.
 */
export function getXarrayDefaultShader(
  metadata: ArrayMetadata,
  channel = "",
): string | undefined {
  const { dataType } = metadata;
  if (!SHADER_DATA_TYPES.includes(dataType)) return undefined;
  const isFloat = dataType === DataType.FLOAT32;
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
  const { scale, offset } = getCfPacking(attrs);
  const isPacked = scale !== 1 || offset !== 0;
  // The range applies to the packed values; reverse it if unpacking reverses the order.
  if (range !== undefined && scale < 0) range = [range[1], range[0]];
  const parameters: string[] = [];
  if (range !== undefined) parameters.push(`range=[${range[0]}, ${range[1]}]`);
  if (channel !== "") parameters.push(`channel=${channel}`);
  const parameterString =
    parameters.length === 0 ? "" : `(${parameters.join(", ")})`;
  const rawName = isPacked ? "raw" : "value";
  const rawExpr = isFloat
    ? `getDataValue(${channel})`
    : `float(toRaw(getDataValue(${channel})))`;
  let missingTest: string | undefined;
  if (isFloat) {
    missingTest = getMissingValueTest(metadata, rawName);
  } else {
    const missing = getMissingValue(metadata);
    if (missing !== undefined && Number.isFinite(missing)) {
      missingTest = `${rawName} == ${glslFloat(missing)}`;
    }
  }
  const lines = [
    `#uicontrol invlerp normalized${parameterString}`,
    "void main() {",
    `  float ${rawName} = ${rawExpr};`,
  ];
  if (missingTest !== undefined) {
    lines.push(
      `  if (${missingTest}) {`,
      "    emitTransparent();",
      "    return;",
      "  }",
    );
  }
  if (isPacked) {
    lines.push(
      "  // Unpacked value (the colormap range applies to the packed value).",
      `  float value = raw * ${glslFloat(scale)} + ${glslFloat(offset)};`,
    );
  }
  lines.push("  emitRGB(colormapJet(normalized()));", "}", "");
  return lines.join("\n");
}

// Names of the trailing dimension of CF bounds arrays.
const BOUNDS_DIMENSION_NAMES = [
  "bnds",
  "bnd",
  "nbnd",
  "nbnds",
  "bounds",
  "nv",
  "nv4",
  "nvertex",
  "d2",
];

/**
 * Selects the data variable of an xarray dataset to display: the requested variable, or by
 * default the primary data variable, preferring variables with longitude and latitude dimensions,
 * then higher rank, then more elements.  Coordinates, auxiliary coordinates, and CF bounds arrays
 * are not data variables.
 */
export function selectXarrayVariable(
  arrays: Map<string, XarrayArrayInfo>,
  requested: string | undefined,
): string {
  if (requested !== undefined) {
    if (!arrays.has(requested)) {
      throw new Error(
        `Variable ${JSON.stringify(requested)} not found in dataset`,
      );
    }
    return requested;
  }
  const coordinates = new Set<string>();
  for (const [name, array] of arrays) {
    if (array.dims.length === 1 && array.dims[0] === name)
      coordinates.add(name);
    for (const key of ["coordinates", "bounds", "climatology"]) {
      const value = array.attrs[key];
      if (typeof value === "string") {
        for (const c of value.split(/\s+/)) coordinates.add(c);
      }
    }
  }
  const candidates = Array.from(arrays.keys())
    .filter((name) => {
      const { shape, dims } = arrays.get(name)!;
      return (
        !coordinates.has(name) &&
        shape.length >= 2 &&
        !dims.some((d) => BOUNDS_DIMENSION_NAMES.includes(d.toLowerCase()))
      );
    })
    .sort();
  if (candidates.length === 0) {
    throw new Error("Dataset contains no data variables");
  }
  const score = (name: string) => {
    const { shape, dims } = arrays.get(name)!;
    const lowerDims = dims.map((d) => d.toLowerCase());
    const isGeographic =
      lowerDims.some((d) => LONGITUDE_NAMES.includes(d)) &&
      lowerDims.some((d) => LATITUDE_NAMES.includes(d));
    return [
      isGeographic ? 1 : 0,
      shape.length,
      shape.reduce((a, b) => a * b, 1),
    ];
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const name of candidates) {
    const s = score(name);
    for (let i = 0; i < s.length; ++i) {
      if (s[i] === bestScore[i]) continue;
      if (s[i] > bestScore[i]) {
        best = name;
        bestScore = s;
      }
      break;
    }
  }
  return best;
}

/**
 * Returns the georeference of an array of a GeoZarr dataset from the attributes of the `proj:`
 * and `spatial:` zarr conventions (https://github.com/zarr-conventions/spatial,
 * https://github.com/zarr-experimental/geo-proj): the CRS (`proj:code` or `proj:wkt2`) and the
 * affine transform from pixel to CRS coordinates (`spatial:transform`, in the order
 * `[a, b, c, d, e, f]` with `x = a * column + b * row + c` and `y = d * column + e * row + f`) of
 * the dimensions `spatial:dimensions` (`[y, x]`).  Returns `undefined` if the attributes are
 * missing or not supported (e.g. rotated transforms).
 *
 * @param attrs Attributes of the array, merged with those of the enclosing groups.
 */
export function getGeoZarrGeoreference(
  attrs: Record<string, unknown>,
  dimensionNames: readonly (string | null)[],
): XarrayGeoreference | undefined {
  const crs = attrs["proj:code"] ?? attrs["proj:wkt2"];
  if (typeof crs !== "string" || crs === "") return undefined;
  const transform = attrs["spatial:transform"];
  if (
    !Array.isArray(transform) ||
    transform.length < 6 ||
    !transform.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return undefined;
  }
  const [a, b, c, d, e, f] = transform as number[];
  if (b !== 0 || d !== 0 || a === 0 || e === 0) return undefined;
  const dimensions = attrs["spatial:dimensions"] ?? ["y", "x"];
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 2 ||
    !dimensions.every((x) => typeof x === "string")
  ) {
    return undefined;
  }
  const [yName, xName] = dimensions as string[];
  const lonDim = dimensionNames.indexOf(xName);
  const latDim = dimensionNames.indexOf(yName);
  if (lonDim === -1 || latDim === -1) return undefined;
  // With "pixel" registration (the default), the transform maps pixel corners; with "node"
  // registration, pixel centers.
  const halfPixel = attrs["spatial:registration"] === "node" ? 0 : 0.5;
  return {
    crs,
    lonDim,
    latDim,
    lon: { start: c + halfPixel * a, step: a },
    lat: { start: f + halfPixel * e, step: e },
    verticalScales: new Map(),
    verticalElevations: new Map(),
  };
}

/**
 * A resolution level of a GeoZarr multiscale group.
 */
export interface GeoZarrMultiscaleLevel {
  /**
   * Path of the level group, relative to the multiscale group.
   */
  asset: string;
  /**
   * Attributes of the level (e.g. `spatial:transform`) specified in the layout.
   */
  attrs: Record<string, unknown>;
}

/**
 * Returns the resolution levels of a group following the multiscales zarr convention
 * (https://github.com/zarr-conventions/multiscales), ordered as in its layout (from the finest
 * resolution), or `undefined` if the group does not follow it.
 */
export function parseGeoZarrMultiscales(
  attrs: Record<string, unknown>,
): GeoZarrMultiscaleLevel[] | undefined {
  const multiscales = attrs.multiscales as { layout?: unknown } | undefined;
  if (multiscales == null || typeof multiscales !== "object") return undefined;
  const { layout } = multiscales;
  if (!Array.isArray(layout) || layout.length === 0) return undefined;
  const levels: GeoZarrMultiscaleLevel[] = [];
  for (const entry of layout) {
    if (entry == null || typeof entry !== "object") return undefined;
    const { asset, ...rest } = entry as Record<string, unknown>;
    if (typeof asset !== "string" || asset === "") return undefined;
    levels.push({ asset, attrs: rest });
  }
  return levels;
}
