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
 * @file Decoding of TIFF tiles and strips.
 */

import {
  TiffCompression,
  TiffSampleFormat,
} from "#src/datasource/geotiff/tiff.js";
import { DataType } from "#src/util/data_type.js";
import { decodeGzip } from "#src/util/gzip.js";

/**
 * Parameters needed to decode the tiles of a TIFF image.
 */
export interface TiffTileFormat {
  compression: number;
  predictor: number;
  bitsPerSample: number;
  sampleFormat: TiffSampleFormat;
  /**
   * Number of samples stored in each tile: `samplesPerPixel` for planar configuration 1, `1` for
   * planar configuration 2.
   */
  samplesPerTile: number;
  littleEndian: boolean;
  tileWidth: number;
  tileHeight: number;
  jpegTables?: Uint8Array;
}

/**
 * Returns the Neuroglancer data type for TIFF samples.
 */
export function getTiffDataType(
  sampleFormat: TiffSampleFormat,
  bitsPerSample: number,
): DataType {
  switch (sampleFormat) {
    case TiffSampleFormat.UINT:
      switch (bitsPerSample) {
        case 8:
          return DataType.UINT8;
        case 16:
          return DataType.UINT16;
        case 32:
          return DataType.UINT32;
        case 64:
          return DataType.UINT64;
      }
      break;
    case TiffSampleFormat.INT:
      switch (bitsPerSample) {
        case 8:
          return DataType.INT8;
        case 16:
          return DataType.INT16;
        case 32:
          return DataType.INT32;
      }
      break;
    case TiffSampleFormat.FLOAT:
      switch (bitsPerSample) {
        case 32:
        case 64:
          // 64-bit floats are converted to 32-bit.
          return DataType.FLOAT32;
      }
      break;
  }
  throw new Error(
    `Unsupported TIFF sample format ${sampleFormat} with ${bitsPerSample} bits per sample`,
  );
}

/**
 * Decodes TIFF LZW-compressed data.
 */
export function decodeLzw(
  input: Uint8Array,
  expectedLength?: number,
): Uint8Array {
  const CLEAR_CODE = 256;
  const EOI_CODE = 257;
  const MAX_CODE = 4095;
  // Dictionary entries stored as (prefix code, last byte, length).
  const prefix = new Int32Array(MAX_CODE + 1);
  const suffix = new Uint8Array(MAX_CODE + 1);
  const lengths = new Uint32Array(MAX_CODE + 1);
  for (let i = 0; i < 256; ++i) {
    prefix[i] = -1;
    suffix[i] = i;
    lengths[i] = 1;
  }
  let output = new Uint8Array(expectedLength ?? input.length * 4);
  let outLength = 0;
  const ensureCapacity = (n: number) => {
    if (outLength + n <= output.length) return;
    let newSize = output.length * 2;
    while (newSize < outLength + n) newSize *= 2;
    const newOutput = new Uint8Array(newSize);
    newOutput.set(output.subarray(0, outLength));
    output = newOutput;
  };
  const writeCode = (code: number) => {
    const length = lengths[code];
    ensureCapacity(length);
    let pos = outLength + length - 1;
    let c = code;
    while (c !== -1) {
      output[pos--] = suffix[c];
      c = prefix[c];
    }
    outLength += length;
  };
  const firstByte = (code: number) => {
    let c = code;
    while (prefix[c] !== -1) c = prefix[c];
    return suffix[c];
  };
  let bitPos = 0;
  const totalBits = input.length * 8;
  let codeLength = 9;
  let nextCode = 258;
  let oldCode = -1;
  while (bitPos + codeLength <= totalBits) {
    // Read `codeLength` bits, MSB first.
    let code = 0;
    for (let i = 0; i < codeLength; ++i) {
      const bit = (input[(bitPos + i) >> 3] >> (7 - ((bitPos + i) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += codeLength;
    if (code === EOI_CODE) break;
    if (code === CLEAR_CODE) {
      codeLength = 9;
      nextCode = 258;
      oldCode = -1;
      continue;
    }
    if (oldCode === -1) {
      if (code > 255) throw new Error("Invalid LZW data");
      writeCode(code);
      oldCode = code;
      continue;
    }
    if (code < nextCode) {
      writeCode(code);
      if (nextCode <= MAX_CODE) {
        prefix[nextCode] = oldCode;
        suffix[nextCode] = firstByte(code);
        lengths[nextCode] = lengths[oldCode] + 1;
        ++nextCode;
      }
    } else if (code === nextCode && nextCode <= MAX_CODE) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = firstByte(oldCode);
      lengths[nextCode] = lengths[oldCode] + 1;
      ++nextCode;
      writeCode(code);
    } else {
      throw new Error("Invalid LZW data");
    }
    oldCode = code;
    // Early change: code length increases one code early.
    if (nextCode + 1 >= 1 << codeLength && codeLength < 12) {
      ++codeLength;
    }
  }
  return output.subarray(0, outLength);
}

/**
 * Decodes PackBits-compressed data.
 */
export function decodePackBits(input: Uint8Array, expectedLength: number) {
  const output = new Uint8Array(expectedLength);
  let inPos = 0;
  let outPos = 0;
  while (inPos < input.length && outPos < expectedLength) {
    const n = (input[inPos++] << 24) >> 24;
    if (n >= 0) {
      const count = Math.min(n + 1, expectedLength - outPos);
      output.set(input.subarray(inPos, inPos + count), outPos);
      inPos += n + 1;
      outPos += count;
    } else if (n !== -128) {
      const count = Math.min(1 - n, expectedLength - outPos);
      output.fill(input[inPos++], outPos, outPos + count);
      outPos += count;
    }
  }
  return output;
}

/**
 * Constructs a complete JPEG stream from abbreviated tile data and the JPEGTables tag.
 */
export function mergeJpegTables(tables: Uint8Array, data: Uint8Array) {
  // Strip EOI from the tables and SOI from the data.
  const tablesEnd =
    tables.length >= 2 &&
    tables[tables.length - 2] === 0xff &&
    tables[tables.length - 1] === 0xd9
      ? tables.length - 2
      : tables.length;
  const dataStart =
    data.length >= 2 && data[0] === 0xff && data[1] === 0xd8 ? 2 : 0;
  const result = new Uint8Array(tablesEnd + data.length - dataStart);
  result.set(tables.subarray(0, tablesEnd));
  result.set(data.subarray(dataStart), tablesEnd);
  return result;
}

export interface ImageDecoders {
  /**
   * Decodes a JPEG image to planar 8-bit samples.
   */
  jpeg?: (data: Uint8Array, numComponents: number) => Promise<Uint8Array>;
  /**
   * Decodes Zstandard-compressed data.
   */
  zstd?: (data: Uint8Array) => Promise<Uint8Array>;
  /**
   * Decodes a WebP image to planar 8-bit samples.
   */
  webp?: (data: Uint8Array, numComponents: number) => Promise<Uint8Array>;
}

export interface DecompressedTile {
  data: Uint8Array;
  /**
   * Indicates that the samples are stored in planar rather than interleaved order (only for image
   * codecs like JPEG).
   */
  planar: boolean;
}

/**
 * Decompresses a tile.
 */
export async function decompressTile(
  input: Uint8Array<ArrayBuffer>,
  format: TiffTileFormat,
  decoders: ImageDecoders = {},
): Promise<DecompressedTile> {
  const { tileWidth, tileHeight, samplesPerTile, bitsPerSample } = format;
  const expectedLength =
    tileWidth * tileHeight * samplesPerTile * (bitsPerSample / 8);
  switch (format.compression) {
    case TiffCompression.NONE:
      return { data: input, planar: false };
    case TiffCompression.LZW:
      return { data: decodeLzw(input, expectedLength), planar: false };
    case TiffCompression.DEFLATE:
    case TiffCompression.DEFLATE_LEGACY:
      return {
        data: new Uint8Array(await decodeGzip(input, "deflate")),
        planar: false,
      };
    case TiffCompression.PACKBITS:
      return { data: decodePackBits(input, expectedLength), planar: false };
    case TiffCompression.ZSTD:
      if (decoders.zstd === undefined) break;
      return { data: await decoders.zstd(input), planar: false };
    case TiffCompression.JPEG: {
      if (decoders.jpeg === undefined) break;
      const data =
        format.jpegTables === undefined
          ? input
          : mergeJpegTables(format.jpegTables, input);
      return { data: await decoders.jpeg(data, samplesPerTile), planar: true };
    }
    case TiffCompression.WEBP:
      if (decoders.webp === undefined) break;
      return {
        data: await decoders.webp(input, samplesPerTile),
        planar: true,
      };
  }
  throw new Error(`Unsupported TIFF compression: ${format.compression}`);
}

type SampleArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigUint64Array;

function makeSampleArray(
  sampleFormat: TiffSampleFormat,
  bitsPerSample: number,
  length: number,
): SampleArray {
  switch (sampleFormat) {
    case TiffSampleFormat.FLOAT:
      return bitsPerSample === 64
        ? new Float64Array(length)
        : new Float32Array(length);
    case TiffSampleFormat.INT:
      switch (bitsPerSample) {
        case 8:
          return new Int8Array(length);
        case 16:
          return new Int16Array(length);
        default:
          return new Int32Array(length);
      }
    default:
      switch (bitsPerSample) {
        case 8:
          return new Uint8Array(length);
        case 16:
          return new Uint16Array(length);
        case 64:
          return new BigUint64Array(length);
        default:
          return new Uint32Array(length);
      }
  }
}

/**
 * Converts decompressed bytes to samples in native byte order, undoing any predictor.  The result
 * has `tileWidth * rows * samplesPerTile` samples in interleaved order, where `rows` is the number
 * of complete rows in the data.
 */
export function decodeSamples(
  raw: Uint8Array,
  format: TiffTileFormat,
): SampleArray {
  const {
    bitsPerSample,
    sampleFormat,
    samplesPerTile,
    tileWidth,
    littleEndian,
    predictor,
  } = format;
  const bytesPerSample = bitsPerSample / 8;
  const rowSamples = tileWidth * samplesPerTile;
  const rowBytes = rowSamples * bytesPerSample;
  const rows = Math.min(format.tileHeight, Math.floor(raw.length / rowBytes));
  const numSamples = rows * rowSamples;
  const samples = makeSampleArray(sampleFormat, bitsPerSample, numSamples);
  if (predictor === 3) {
    // Floating point predictor: bytes of each row are differenced, then shuffled such that byte
    // `j` (most significant first) of sample `i` is at position `j * rowSamples + i`.
    if (sampleFormat !== TiffSampleFormat.FLOAT) {
      throw new Error(
        "TIFF floating point predictor requires floating point samples",
      );
    }
    const rowBuffer = new Uint8Array(rowBytes);
    const sampleBytes = new Uint8Array(8);
    const sampleView = new DataView(sampleBytes.buffer);
    for (let row = 0; row < rows; ++row) {
      rowBuffer.set(raw.subarray(row * rowBytes, (row + 1) * rowBytes));
      for (let i = samplesPerTile; i < rowBytes; ++i) {
        rowBuffer[i] = (rowBuffer[i] + rowBuffer[i - samplesPerTile]) & 0xff;
      }
      for (let i = 0; i < rowSamples; ++i) {
        for (let j = 0; j < bytesPerSample; ++j) {
          sampleBytes[j] = rowBuffer[j * rowSamples + i];
        }
        samples[row * rowSamples + i] =
          bytesPerSample === 8
            ? sampleView.getFloat64(0, false)
            : sampleView.getFloat32(0, false);
      }
    }
    return samples;
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytesPerSample === 1) {
    (samples as Uint8Array).set(raw.subarray(0, numSamples));
  } else {
    for (let i = 0; i < numSamples; ++i) {
      const offset = i * bytesPerSample;
      let value: number | bigint;
      switch (sampleFormat) {
        case TiffSampleFormat.FLOAT:
          value =
            bytesPerSample === 8
              ? view.getFloat64(offset, littleEndian)
              : view.getFloat32(offset, littleEndian);
          break;
        case TiffSampleFormat.INT:
          value =
            bytesPerSample === 2
              ? view.getInt16(offset, littleEndian)
              : view.getInt32(offset, littleEndian);
          break;
        default:
          value =
            bytesPerSample === 2
              ? view.getUint16(offset, littleEndian)
              : bytesPerSample === 8
                ? view.getBigUint64(offset, littleEndian)
                : view.getUint32(offset, littleEndian);
          break;
      }
      (samples as any)[i] = value;
    }
  }
  if (predictor === 2) {
    // Horizontal differencing.  Integer typed arrays wrap on overflow as required.
    if (samples instanceof BigUint64Array) {
      for (let row = 0; row < rows; ++row) {
        const base = row * rowSamples;
        for (let i = samplesPerTile; i < rowSamples; ++i) {
          samples[base + i] += samples[base + i - samplesPerTile];
        }
      }
    } else {
      for (let row = 0; row < rows; ++row) {
        const base = row * rowSamples;
        for (let i = samplesPerTile; i < rowSamples; ++i) {
          samples[base + i] += samples[base + i - samplesPerTile];
        }
      }
    }
  }
  return samples;
}

/**
 * Copies decoded tile samples into chunk data of shape `[width, height, numChannels]` (Fortran
 * order).
 *
 * @param samples Decoded samples of a single tile.
 * @param planar Whether `samples` is planar (all samples of channel 0, then channel 1, ...) or
 *     interleaved.
 * @param samplesPerTile Number of channels in `samples`.
 * @param channelOffset Index of the first chunk channel corresponding to `samples`.
 */
export function copyTileToChunk(
  output: SampleArray,
  width: number,
  height: number,
  samples: ArrayLike<number | bigint>,
  planar: boolean,
  tileWidth: number,
  tileHeight: number,
  samplesPerTile: number,
  channelOffset: number,
) {
  const outputPlaneSize = width * height;
  const rows = Math.min(
    height,
    Math.floor(samples.length / (tileWidth * samplesPerTile)),
  );
  const cols = Math.min(width, tileWidth);
  const tilePlaneSize = tileWidth * tileHeight;
  for (let c = 0; c < samplesPerTile; ++c) {
    const outBase = (channelOffset + c) * outputPlaneSize;
    for (let y = 0; y < rows; ++y) {
      const outRow = outBase + y * width;
      if (planar) {
        const inRow = c * tilePlaneSize + y * tileWidth;
        for (let x = 0; x < cols; ++x) {
          (output as any)[outRow + x] = samples[inRow + x];
        }
      } else {
        const inRow = y * tileWidth * samplesPerTile + c;
        for (let x = 0; x < cols; ++x) {
          (output as any)[outRow + x] = samples[inRow + x * samplesPerTile];
        }
      }
    }
  }
}

/**
 * Allocates chunk data for the specified data type.
 */
export function makeChunkData(
  dataType: DataType,
  length: number,
):
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | BigUint64Array {
  switch (dataType) {
    case DataType.UINT8:
      return new Uint8Array(length);
    case DataType.INT8:
      return new Int8Array(length);
    case DataType.UINT16:
      return new Uint16Array(length);
    case DataType.INT16:
      return new Int16Array(length);
    case DataType.UINT32:
      return new Uint32Array(length);
    case DataType.INT32:
      return new Int32Array(length);
    case DataType.UINT64:
      return new BigUint64Array(length);
    case DataType.FLOAT32:
      return new Float32Array(length);
  }
}
