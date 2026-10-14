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

import fs from "node:fs";
import path from "node:path";
import { decompress as decompressZstd } from "fzstd";
import { describe, expect, it, vi } from "vitest";
import type {
  DecodedTiffTile,
  ImageDecoders,
  TiffTileFormat,
  TiffTileLayout,
} from "#src/datasource/geotiff/decode.js";
import {
  copyTileToChunk,
  decodeLzw,
  decodePackBits,
  decodeSamples,
  decodeTiffTile,
  decompressTile,
  getTiffChunkSize,
  getTiffDataType,
  makeChunkData,
  readTiffChunk,
} from "#src/datasource/geotiff/decode.js";
import { getGeoTiffGeoreference } from "#src/datasource/geotiff/geokeys.js";
import {
  getGeoTiffDefaultShader,
  getTiffScales,
} from "#src/datasource/geotiff/metadata.js";
import type {
  ByteRangeReader,
  TiffFile,
  TiffImage,
} from "#src/datasource/geotiff/tiff.js";
import {
  BlockCachingReader,
  getByteRangeFromResponse,
  isTiffHeader,
  readTiff,
} from "#src/datasource/geotiff/tiff.js";
import {
  CoalescingRangeReader,
  DecodedTileCache,
} from "#src/datasource/geotiff/tile_cache.js";
import { getCrs } from "#src/geo/crs.js";
import { CrsTransform } from "#src/geo/transform.js";
import { JpegDecoder } from "#src/third_party/jpgjs/jpg.js";
import { transposeArray2d } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";

const TESTDATA_DIR = path.resolve(
  import.meta.dirname,
  "../../../testdata/datasource/geotiff",
);

const WIDTH = 70;
const HEIGHT = 45;

function makeReader(data: Uint8Array): ByteRangeReader {
  return {
    async read(offset, length) {
      if (offset + length > data.length) {
        throw new Error("Read beyond end of file");
      }
      return data.slice(offset, offset + length);
    },
  };
}

async function readTestTiff(name: string): Promise<TiffFile> {
  const data = new Uint8Array(fs.readFileSync(path.join(TESTDATA_DIR, name)));
  return readTiff(new BlockCachingReader(makeReader(data), 512, data.length));
}

const testDecoders: ImageDecoders = {
  zstd: async (data) => decompressZstd(data),
  jpeg: async (data, numComponents) => {
    const parser = new JpegDecoder();
    parser.parse(data);
    const interleaved = parser.getData(parser.width, parser.height, true);
    return transposeArray2d(
      interleaved,
      parser.width * parser.height,
      numComponents,
    );
  },
};

/**
 * Decodes all tiles of an image into an array of shape `[width, height, samples]` (Fortran
 * order).
 */
async function decodeImage(
  file: TiffFile,
  image: TiffImage,
  fileData: Uint8Array,
) {
  const dataType = getTiffDataType(image.sampleFormat, image.bitsPerSample);
  const { width, height, tileWidth, tileHeight, samplesPerPixel } = image;
  const output = makeChunkData(dataType, width * height * samplesPerPixel);
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  const planes = image.planarConfiguration === 2 ? samplesPerPixel : 1;
  const samplesPerTile = planes === 1 ? samplesPerPixel : 1;
  const format = {
    compression: image.compression,
    predictor: image.predictor,
    bitsPerSample: image.bitsPerSample,
    sampleFormat: image.sampleFormat,
    samplesPerTile,
    littleEndian: file.littleEndian,
    tileWidth,
    tileHeight,
    jpegTables: image.jpegTables,
  };
  for (let plane = 0; plane < planes; ++plane) {
    for (let ty = 0; ty < tilesDown; ++ty) {
      for (let tx = 0; tx < tilesAcross; ++tx) {
        const index = plane * tilesAcross * tilesDown + ty * tilesAcross + tx;
        const offset = image.offsets[index];
        const length = image.byteCounts[index];
        const compressed = fileData.slice(offset, offset + length);
        const decompressed = await decompressTile(
          compressed,
          format,
          testDecoders,
        );
        const samples = decompressed.planar
          ? decompressed.data
          : decodeSamples(decompressed.data, format);
        const chunkWidth = Math.min(tileWidth, width - tx * tileWidth);
        const chunkHeight = Math.min(tileHeight, height - ty * tileHeight);
        const chunk = makeChunkData(
          dataType,
          chunkWidth * chunkHeight * samplesPerPixel,
        );
        copyTileToChunk(
          chunk,
          chunkWidth,
          chunkHeight,
          samples,
          decompressed.planar,
          tileWidth,
          tileHeight,
          samplesPerTile,
          plane,
        );
        // Copy chunk into the full image.
        for (let c = 0; c < samplesPerPixel; ++c) {
          if (planes !== 1 && c !== plane) continue;
          for (let y = 0; y < chunkHeight; ++y) {
            for (let x = 0; x < chunkWidth; ++x) {
              (output as any)[
                c * width * height +
                  (ty * tileHeight + y) * width +
                  tx * tileWidth +
                  x
              ] = (chunk as any)[
                c * chunkWidth * chunkHeight + y * chunkWidth + x
              ];
            }
          }
        }
      }
    }
  }
  return { dataType, output };
}

/**
 * Pattern used by `generate_geotiff.py`.
 */
function pattern(dataType: DataType, x: number, y: number, c: number) {
  switch (dataType) {
    case DataType.FLOAT32:
      return x * 0.5 - y * 0.25 + c * 3;
    case DataType.UINT8:
      return (x * 3 + y * 7 + c * 11) % 256;
    case DataType.INT16:
      return x * 37 - y * 101 + c * 7;
    case DataType.UINT16:
      return (x * 1000 + y * 3 + c * 17) % 65536;
    default:
      return x * 1000 + y * 3 + c * 17;
  }
}

/**
 * Reads the chunk with origin `(x0, y0)` and size `width * height` of the base image of a test
 * file, as done by the backend.
 */
async function readTestChunk(
  file: TiffFile,
  image: TiffImage,
  fileData: Uint8Array,
  x0: number,
  y0: number,
  width: number,
  height: number,
  getTileWrapper?: (
    index: number,
    getTile: () => Promise<DecodedTiffTile>,
  ) => Promise<DecodedTiffTile | undefined>,
) {
  const dataType = getTiffDataType(image.sampleFormat, image.bitsPerSample);
  const layout: TiffTileLayout = image;
  const format: TiffTileFormat = {
    compression: image.compression,
    predictor: image.predictor,
    bitsPerSample: image.bitsPerSample,
    sampleFormat: image.sampleFormat,
    samplesPerTile: image.planarConfiguration === 2 ? 1 : image.samplesPerPixel,
    littleEndian: file.littleEndian,
    tileWidth: image.tileWidth,
    tileHeight: image.tileHeight,
    jpegTables: image.jpegTables,
  };
  const output = makeChunkData(
    dataType,
    width * height * image.samplesPerPixel,
  );
  await readTiffChunk(output, x0, y0, width, height, layout, (index, rows) => {
    const getTile = () => {
      const offset = image.offsets[index];
      const compressed = fileData.slice(
        offset,
        offset + image.byteCounts[index],
      );
      return decodeTiffTile(compressed, format, rows, testDecoders);
    };
    return getTileWrapper === undefined
      ? getTile()
      : getTileWrapper(index, getTile);
  });
  return { dataType, output };
}

interface TestIfdEntry {
  tag: number;
  type: number;
  values?: number[];
  // Raw count and value/offset field, for crafting malformed entries.
  raw?: { count: number; value: number };
}

/**
 * Constructs a little-endian classic TIFF file containing the specified image file directories.
 * Values that do not fit in an entry are stored after the directory.
 */
function makeTestTiff(ifds: TestIfdEntry[][]): Uint8Array {
  const data = new Uint8Array(4096);
  const view = new DataView(data.buffer);
  data.set([0x49, 0x49, 42, 0]);
  let pos = 8;
  view.setUint32(4, pos, true);
  ifds.forEach((entries, ifdIndex) => {
    const ifdStart = pos;
    view.setUint16(pos, entries.length, true);
    let dataPos = ifdStart + 2 + 12 * entries.length + 4;
    entries.forEach(({ tag, type, values, raw }, i) => {
      const e = ifdStart + 2 + 12 * i;
      view.setUint16(e, tag, true);
      view.setUint16(e + 2, type, true);
      if (raw !== undefined) {
        view.setUint32(e + 4, raw.count, true);
        view.setUint32(e + 8, raw.value, true);
        return;
      }
      const size = type === 3 ? 2 : 4;
      view.setUint32(e + 4, values!.length, true);
      let valuePos = e + 8;
      if (values!.length * size > 4) {
        view.setUint32(e + 8, dataPos, true);
        valuePos = dataPos;
        dataPos += values!.length * size;
      }
      values!.forEach((v, j) => {
        if (size === 2) view.setUint16(valuePos + 2 * j, v, true);
        else view.setUint32(valuePos + 4 * j, v, true);
      });
    });
    pos = dataPos;
    view.setUint32(
      ifdStart + 2 + 12 * entries.length,
      ifdIndex + 1 < ifds.length ? pos : 0,
      true,
    );
  });
  return data.slice(0, pos);
}

const SHORT = 3;
const LONG = 4;

/**
 * Entries of a valid 4x4 single-strip 8-bit image.
 */
function makeTestImageEntries(): TestIfdEntry[] {
  return [
    { tag: 256, type: SHORT, values: [4] },
    { tag: 257, type: SHORT, values: [4] },
    { tag: 258, type: SHORT, values: [8] },
    { tag: 273, type: LONG, values: [0] },
    { tag: 278, type: SHORT, values: [4] },
    { tag: 279, type: LONG, values: [16] },
  ];
}

/**
 * Returns a reader that records the largest requested length.
 */
function makeRecordingReader(data: Uint8Array) {
  const result = { maxLength: 0, reader: makeReader(data) };
  const base = result.reader;
  result.reader = {
    read(offset, length) {
      result.maxLength = Math.max(result.maxLength, length);
      return base.read(offset, length);
    },
  };
  return result;
}

/**
 * Returns a TIFF image with the specified GeoTIFF keys (as `[key, value]` pairs, where non-integer
 * values are stored as doubles), georeferenced with a pixel size of 1.
 */
function makeGeoKeysImage(keys: [number, number][]): TiffImage {
  const directory = [1, 1, 0, keys.length];
  const doubles: number[] = [];
  for (const [key, value] of keys) {
    if (Number.isInteger(value) && value >= 0 && value < 65536) {
      directory.push(key, 0, 1, value);
    } else {
      directory.push(key, 34736, 1, doubles.length);
      doubles.push(value);
    }
  }
  const tags = new Map<number, number[]>([
    [34735, directory],
    [34736, doubles],
    [33550, [1, 1, 0]],
    [33922, [0, 0, 0, 0, 0, 0]],
  ]);
  return { tags } as unknown as TiffImage;
}

describe("geotiff", () => {
  it("detects TIFF headers", () => {
    expect(isTiffHeader(Uint8Array.of(0x49, 0x49, 42, 0))).toBe(true);
    expect(isTiffHeader(Uint8Array.of(0x4d, 0x4d, 0, 43))).toBe(true);
    expect(isTiffHeader(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(false);
  });

  it("decodes test images", async () => {
    const cases: {
      name: string;
      dataType: DataType;
      samples: number;
      bigTiff: boolean;
      numScales: number;
      exact: boolean;
    }[] = [
      {
        name: "utm_rgb_deflate_predictor.tif",
        dataType: DataType.UINT8,
        samples: 3,
        bigTiff: false,
        numScales: 3,
        exact: true,
      },
      {
        name: "geographic_uint16_lzw_bigtiff.tif",
        dataType: DataType.UINT16,
        samples: 1,
        bigTiff: true,
        numScales: 1,
        exact: true,
      },
      {
        name: "float32_planar_floatpredictor.tif",
        dataType: DataType.FLOAT32,
        samples: 2,
        bigTiff: false,
        numScales: 1,
        exact: true,
      },
      {
        name: "int16_packbits_strips.tif",
        dataType: DataType.INT16,
        samples: 1,
        bigTiff: false,
        numScales: 1,
        exact: true,
      },
      {
        name: "uint32_zstd.tif",
        dataType: DataType.UINT32,
        samples: 1,
        bigTiff: false,
        numScales: 1,
        exact: true,
      },
    ];
    for (const { name, dataType, samples, bigTiff, numScales } of cases) {
      const fileData = new Uint8Array(
        fs.readFileSync(path.join(TESTDATA_DIR, name)),
      );
      const file = await readTestTiff(name);
      expect(file.bigTiff, name).toBe(bigTiff);
      const scales = getTiffScales(file);
      expect(scales.length, name).toBe(numScales);
      const [base] = scales;
      expect([base.width, base.height, base.samplesPerPixel], name).toEqual([
        WIDTH,
        HEIGHT,
        samples,
      ]);
      const decoded = await decodeImage(file, base, fileData);
      expect(decoded.dataType, name).toBe(dataType);
      const mismatches: string[] = [];
      for (let c = 0; c < samples; ++c) {
        for (let y = 0; y < HEIGHT; ++y) {
          for (let x = 0; x < WIDTH; ++x) {
            const actual = Number(
              (decoded.output as any)[c * WIDTH * HEIGHT + y * WIDTH + x],
            );
            const expected = pattern(dataType, x, y, c);
            if (actual !== expected && mismatches.length < 5) {
              mismatches.push(`(${x},${y},${c}): ${actual} !== ${expected}`);
            }
          }
        }
      }
      expect(mismatches, name).toEqual([]);
      // Overviews are downsampled by 2 at each level.
      for (let i = 1; i < scales.length; ++i) {
        expect(scales[i].width, name).toBe(Math.ceil(scales[i - 1].width / 2));
        const overview = await decodeImage(file, scales[i], fileData);
        const f = 2 ** i;
        expect(
          Number((overview.output as any)[1 + scales[i].width]),
          name,
        ).toBe(pattern(dataType, f, f, 0));
      }
    }
  });

  it("decodes JPEG tiles", async () => {
    const name = "rgb_jpeg.tif";
    const fileData = new Uint8Array(
      fs.readFileSync(path.join(TESTDATA_DIR, name)),
    );
    const file = await readTestTiff(name);
    const [base] = getTiffScales(file);
    const decoded = await decodeImage(file, base, fileData);
    for (const value of decoded.output as Uint8Array) {
      // JPEG is lossy; edge tiles are padded by the encoder.
      expect(Math.abs(value - 128)).toBeLessThanOrEqual(8);
    }
  });

  it("determines georeferencing", async () => {
    const cases: {
      name: string;
      crs: string | undefined;
      pixelToCrs: number[] | undefined;
    }[] = [
      {
        name: "utm_rgb_deflate_predictor.tif",
        crs: "EPSG:32633",
        pixelToCrs: [10, 0, 0, -10, 399960, 4200000],
      },
      {
        // PixelIsPoint: shifted by half a pixel.
        name: "geographic_uint16_lzw_bigtiff.tif",
        crs: "EPSG:4326",
        pixelToCrs: [0.25, 0, 0, -0.25, 9.875, 50.125],
      },
      {
        // ModelTransformation tag.
        name: "float32_planar_floatpredictor.tif",
        crs: "EPSG:32633",
        pixelToCrs: [10, 0, 0, -10, 399960, 4200000],
      },
      {
        name: "uint32_zstd.tif",
        crs: undefined,
        pixelToCrs: undefined,
      },
    ];
    for (const { name, crs, pixelToCrs } of cases) {
      const file = await readTestTiff(name);
      const georeference = getGeoTiffGeoreference(getTiffScales(file)[0]);
      expect(georeference?.crs, name).toBe(crs);
      expect(georeference?.pixelToCrs, name).toEqual(pixelToCrs);
    }
  });

  it("constructs user-defined projections", async () => {
    const file = await readTestTiff("int16_packbits_strips.tif");
    const georeference = getGeoTiffGeoreference(getTiffScales(file)[0])!;
    expect(georeference.crs).toMatch(/^\+proj=tmerc /);
    // Equivalent to UTM zone 33N.
    const t = new CrsTransform(getCrs(georeference.crs!), getCrs("EPSG:32633"));
    const out = new Float64Array(2);
    t.forward(450000, 4100000, out);
    expect(out[0]).toBeCloseTo(450000, 3);
    expect(out[1]).toBeCloseTo(4100000, 3);
  });

  it("decodes chunks of stripped images", async () => {
    const cases: {
      name: string;
      chunks: [x0: number, y0: number, width: number, height: number][];
      tolerance: number;
      expected: (x: number, y: number, c: number) => number;
    }[] = [
      {
        // 7 rows per strip; the last strip has 3 rows.
        name: "int16_packbits_strips.tif",
        chunks: [
          [0, 0, 70, 45], // All strips.
          [0, 7, 70, 21], // Group of whole strips.
          [10, 3, 30, 20], // Horizontal piece straddling strips.
          [50, 8, 16, 4], // Smaller than a strip.
          [64, 40, 6, 5], // Includes the last (shorter) strip.
        ],
        tolerance: 0,
        expected: (x, y, c) => pattern(DataType.INT16, x, y, c),
      },
      {
        // 16 rows per strip; the last strip is encoded with only 13 rows.
        name: "rgb_jpeg_strips.tif",
        chunks: [
          [0, 0, 70, 45],
          [20, 30, 33, 15],
        ],
        tolerance: 8,
        expected: (_x, y, c) => [y * 5, 128, 255 - y * 5][c],
      },
    ];
    for (const { name, chunks, tolerance, expected } of cases) {
      const fileData = new Uint8Array(
        fs.readFileSync(path.join(TESTDATA_DIR, name)),
      );
      const file = await readTestTiff(name);
      const [base] = getTiffScales(file);
      expect(base.isTiled, name).toBe(false);
      for (const [x0, y0, width, height] of chunks) {
        const { output } = await readTestChunk(
          file,
          base,
          fileData,
          x0,
          y0,
          width,
          height,
        );
        const mismatches: string[] = [];
        for (let c = 0; c < base.samplesPerPixel; ++c) {
          for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
              const actual = Number(
                (output as any)[c * width * height + y * width + x],
              );
              const e = expected(x0 + x, y0 + y, c);
              if (Math.abs(actual - e) > tolerance && mismatches.length < 5) {
                mismatches.push(
                  `(${x0 + x},${y0 + y},${c}): ${actual} !== ${e}`,
                );
              }
            }
          }
        }
        expect(mismatches, `${name} ${[x0, y0, width, height]}`).toEqual([]);
      }
    }
  });

  it("decodes each shared strip once", async () => {
    const name = "int16_packbits_strips.tif";
    const fileData = new Uint8Array(
      fs.readFileSync(path.join(TESTDATA_DIR, name)),
    );
    const file = await readTestTiff(name);
    const [base] = getTiffScales(file);
    const cache = new DecodedTileCache<DecodedTiffTile>(
      1 << 20,
      (tile) => tile.data.byteLength,
    );
    const decoded: number[] = [];
    const signal = new AbortController().signal;
    // Horizontal pieces of the same strips, read concurrently and then again.
    for (let pass = 0; pass < 2; ++pass) {
      await Promise.all(
        [0, 20, 40, 60].map((x0) =>
          readTestChunk(file, base, fileData, x0, 0, 10, 14, (index, get) =>
            cache.get(index, signal, () => {
              decoded.push(index);
              return get();
            }),
          ),
        ),
      );
    }
    expect(decoded).toEqual([0, 1]);
  });

  it("coalesces nearby byte range reads", async () => {
    const file = Uint8Array.from({ length: 20000 }, (_, i) => i % 251);
    const requests: [number, number][] = [];
    const reader = new CoalescingRangeReader(async (offset, length) => {
      requests.push([offset, length]);
      return file.slice(offset, offset + length);
    });
    const signal = new AbortController().signal;
    const ranges: [number, number][] = [
      [10, 5],
      [0, 10],
      [20, 5], // Small gap.
      [10000, 4], // Large gap.
      [10000, 2], // Overlapping.
    ];
    const results = await Promise.all(
      ranges.map(([offset, length]) => reader.read(offset, length, signal)),
    );
    expect(requests).toEqual([
      [0, 25],
      [10000, 4],
    ]);
    ranges.forEach(([offset, length], i) => {
      expect(Array.from(results[i])).toEqual(
        Array.from(file.slice(offset, offset + length)),
      );
    });
  });

  it("aborts coalesced reads only when all requesters abort", async () => {
    const signals: AbortSignal[] = [];
    const reader = new CoalescingRangeReader((_offset, length, signal) => {
      signals.push(signal);
      return new Promise((resolve) =>
        setTimeout(() => resolve(new Uint8Array(length)), 0),
      );
    });
    const a = new AbortController();
    const b = new AbortController();
    const readA = reader.read(0, 4, a.signal);
    const readB = reader.read(4, 4, b.signal);
    await Promise.resolve();
    a.abort();
    await expect(readA).rejects.toBeDefined();
    expect(signals[0].aborted).toBe(false);
    expect((await readB).length).toBe(4);
    const c = new AbortController();
    const d = new AbortController();
    const readC = reader.read(0, 4, c.signal);
    const readD = reader.read(4, 4, d.signal);
    await Promise.resolve();
    c.abort();
    d.abort();
    await expect(readC).rejects.toBeDefined();
    await expect(readD).rejects.toBeDefined();
    expect(signals[1].aborted).toBe(true);
  });

  it("selects chunk sizes", () => {
    const layout = (
      width: number,
      height: number,
      tileWidth: number,
      tileHeight: number,
      isTiled: boolean,
    ): TiffTileLayout => ({
      width,
      height,
      tileWidth,
      tileHeight,
      isTiled,
      samplesPerPixel: 1,
      planarConfiguration: 1,
    });
    const cases: [TiffTileLayout, [number, number]][] = [
      // Tiles are used directly.
      [layout(5000, 5000, 512, 512, true), [512, 512]],
      // Short strips are grouped.
      [layout(70, 45, 70, 7, false), [70, 45]],
      [layout(1000, 1000, 1000, 7, false), [1000, 252]],
      [layout(1000, 1000, 1000, 300, false), [1000, 300]],
      // Wide strips are divided horizontally.
      [layout(7000, 3000, 7000, 1, false), [512, 256]],
      // A single huge strip is divided vertically and horizontally.
      [layout(20000, 20000, 20000, 20000, false), [512, 512]],
    ];
    for (const [l, expected] of cases) {
      expect(getTiffChunkSize(l), JSON.stringify(l)).toEqual(expected);
    }
  });

  it("extracts byte ranges from responses", async () => {
    const file = Uint8Array.from({ length: 100 }, (_, i) => i);
    const cases: [responseOffset: number, data: Uint8Array<ArrayBuffer>][] = [
      // Exact range.
      [10, file.slice(10, 15)],
      // Server ignored the range and returned the entire file.
      [0, file],
      // Larger range.
      [5, file.slice(5, 50)],
    ];
    for (const [responseOffset, data] of cases) {
      const result = await getByteRangeFromResponse(
        { response: new Response(data), offset: responseOffset },
        10,
        5,
      );
      expect(Array.from(result)).toEqual([10, 11, 12, 13, 14]);
    }
  });

  it("rejects truncated byte range responses", async () => {
    await expect(
      getByteRangeFromResponse(
        { response: new Response(new Uint8Array(3)), offset: 10 },
        10,
        5,
      ),
    ).rejects.toThrow(/Received truncated response/);
  });

  it("skips invalid images after the first", async () => {
    const mixedBitsPerSample = makeTestImageEntries().map((e) =>
      e.tag === 258 ? { ...e, values: [8, 16] } : e,
    );
    const missingByteCounts = makeTestImageEntries().filter(
      (e) => e.tag !== 279,
    );
    const data = makeTestTiff([
      makeTestImageEntries(),
      mixedBitsPerSample,
      missingByteCounts,
      makeTestImageEntries(),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const file = await readTiff(makeReader(data));
      expect(file.images.length).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an invalid first image", async () => {
    const data = makeTestTiff([
      makeTestImageEntries().filter((e) => e.tag !== 279),
      makeTestImageEntries(),
    ]);
    await expect(readTiff(makeReader(data))).rejects.toThrow(
      /Missing required TIFF tag 279/,
    );
  });

  it("rejects strip offset counts inconsistent with the dimensions", async () => {
    const entries = makeTestImageEntries().map((e) =>
      e.tag === 273
        ? { tag: 273, type: LONG, raw: { count: 0x3fffffff, value: 8 } }
        : e,
    );
    const { reader, ...recorded } = makeRecordingReader(
      makeTestTiff([entries]),
    );
    await expect(readTiff(reader)).rejects.toThrow(
      /tag 273 has 1073741823 values but 1 expected/,
    );
    expect(recorded.maxLength).toBeLessThan(1024);
  });

  it("rejects oversized tag values", async () => {
    const entries = [
      ...makeTestImageEntries(),
      // ImageDescription
      { tag: 270, type: 2, raw: { count: 0x7fffffff, value: 8 } },
    ];
    await expect(readTiff(makeReader(makeTestTiff([entries])))).rejects.toThrow(
      /tag 270 value of 2147483647 bytes exceeds maximum/,
    );
  });

  it("rejects oversized BigTIFF directories", async () => {
    const data = new Uint8Array(64);
    const view = new DataView(data.buffer);
    data.set([0x49, 0x49, 43, 0, 8, 0, 0, 0]);
    view.setBigUint64(8, 16n, true);
    view.setBigUint64(16, 0x3fffffffn, true);
    const { reader, ...recorded } = makeRecordingReader(data);
    await expect(readTiff(reader)).rejects.toThrow(
      /image file directory has 1073741823 entries/,
    );
    expect(recorded.maxLength).toBeLessThan(1024);
  });

  it("constructs user-defined projections with other parameters", () => {
    // Keys of a transverse Mercator projection equivalent to UTM zone 33N, with the false easting
    // in the specified linear unit.
    const utmKeys = (unit: number, toMeter: number): [number, number][] => [
      [1024, 1],
      [2048, 4326],
      [3072, 32767],
      [3075, 1],
      [3080, 15],
      [3082, 500000 / toMeter],
      [3092, 0.9996],
      [3076, unit],
    ];
    const cases: {
      keys: [number, number][];
      reference: string;
      toMeter: number;
    }[] = [
      {
        keys: utmKeys(9002, 0.3048),
        reference: "EPSG:32633",
        toMeter: 0.3048,
      },
      {
        keys: utmKeys(9003, 1200 / 3937),
        reference: "EPSG:32633",
        toMeter: 1200 / 3937,
      },
      { keys: utmKeys(9036, 1000), reference: "EPSG:32633", toMeter: 1000 },
      {
        keys: [...utmKeys(32767, 0.5), [3077, 0.5]],
        reference: "EPSG:32633",
        toMeter: 0.5,
      },
      {
        // Cylindrical equal area.
        keys: [
          [1024, 1],
          [2048, 4326],
          [3072, 32767],
          [3075, 28],
          [3078, 30],
          [3080, 0],
        ],
        reference: "EPSG:6933",
        toMeter: 1,
      },
      {
        // Mercator (2SP).
        keys: [
          [1024, 1],
          [2048, 4326],
          [3072, 32767],
          [3075, 7],
          [3078, 30.5],
          [3080, 0],
        ],
        reference:
          "+proj=merc +lat_ts=30.5 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
        toMeter: 1,
      },
    ];
    for (const { keys, reference, toMeter } of cases) {
      const { crs } = getGeoTiffGeoreference(makeGeoKeysImage(keys))!;
      expect(crs, JSON.stringify(keys)).toBeDefined();
      const t = new CrsTransform(getCrs(crs!), getCrs(reference));
      const out = new Float64Array(2);
      t.forward(450000 / toMeter, 4100000 / toMeter, out);
      expect(out[0], crs).toBeCloseTo(450000, 3);
      expect(out[1], crs).toBeCloseTo(4100000, 3);
    }
  });

  it("rejects unsupported linear units", () => {
    const georeference = getGeoTiffGeoreference(
      makeGeoKeysImage([
        [1024, 1],
        [3072, 32767],
        [3075, 1],
        [3076, 9014], // Fathom
      ]),
    )!;
    expect(georeference.crs).toBeUndefined();
    expect(georeference.crsError).toMatch(/unsupported linear unit 9014/);
  });

  it("selects default shaders", () => {
    expect(getGeoTiffDefaultShader(DataType.UINT8, 3, 0)).toMatch(/emitRGBA/);
    expect(getGeoTiffDefaultShader(DataType.UINT8, 3, 0)).toMatch(/equal\(rgb/);
    expect(getGeoTiffDefaultShader(DataType.UINT8, 3, undefined)).not.toMatch(
      /equal\(rgb/,
    );
    expect(getGeoTiffDefaultShader(DataType.UINT8, 4, undefined)).toMatch(
      /emitRGBA/,
    );
    expect(
      getGeoTiffDefaultShader(DataType.UINT16, 1, undefined),
    ).toBeUndefined();
  });

  it("decodes PackBits runs", () => {
    // Literal run of 3 bytes, repeat of 4 bytes, no-op, literal run of 1 byte.
    const input = Uint8Array.of(2, 1, 2, 3, 0xfd, 9, 0x80, 0, 7);
    expect(Array.from(decodePackBits(input, 8))).toEqual([
      1, 2, 3, 9, 9, 9, 9, 7,
    ]);
  });

  it("rejects invalid LZW data", () => {
    // Code 300 is not defined immediately after a clear code.
    const bits = "100000000" + "100101100";
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; ++i) {
      if (bits[i] === "1") bytes[i >> 3] |= 1 << (7 - (i & 7));
    }
    expect(() => decodeLzw(bytes)).toThrow(/Invalid LZW data/);
  });

  it("rejects non-TIFF files", async () => {
    await expect(
      readTiff(makeReader(new Uint8Array(64).fill(0x20))),
    ).rejects.toThrow(/Not a TIFF file/);
  });

  it("rejects unsupported compression", async () => {
    await expect(
      decompressTile(new Uint8Array(4), {
        compression: 34887,
        predictor: 1,
        bitsPerSample: 8,
        sampleFormat: 1,
        samplesPerTile: 1,
        littleEndian: true,
        tileWidth: 2,
        tileHeight: 2,
      }),
    ).rejects.toThrow(/Unsupported TIFF compression: 34887/);
  });

  it("rejects unsupported sample formats", () => {
    expect(() => getTiffDataType(3, 16)).toThrow(
      /Unsupported TIFF sample format/,
    );
  });
});
