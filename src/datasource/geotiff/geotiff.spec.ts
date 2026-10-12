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
import { describe, expect, it } from "vitest";
import type { ImageDecoders } from "#src/datasource/geotiff/decode.js";
import {
  copyTileToChunk,
  decodeLzw,
  decodePackBits,
  decodeSamples,
  decompressTile,
  getTiffDataType,
  makeChunkData,
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
  isTiffHeader,
  readTiff,
} from "#src/datasource/geotiff/tiff.js";
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
