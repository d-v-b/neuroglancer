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
 * @file Parser for the structure (image file directories) of TIFF and BigTIFF files, reading only
 * the required byte ranges.
 */

export enum TiffTag {
  NewSubfileType = 254,
  ImageWidth = 256,
  ImageLength = 257,
  BitsPerSample = 258,
  Compression = 259,
  PhotometricInterpretation = 262,
  StripOffsets = 273,
  SamplesPerPixel = 277,
  RowsPerStrip = 278,
  StripByteCounts = 279,
  PlanarConfiguration = 284,
  Predictor = 317,
  TileWidth = 322,
  TileLength = 323,
  TileOffsets = 324,
  TileByteCounts = 325,
  ExtraSamples = 338,
  SampleFormat = 339,
  JPEGTables = 347,
  ModelPixelScale = 33550,
  ModelTiepoint = 33922,
  ModelTransformation = 34264,
  GeoKeyDirectory = 34735,
  GeoDoubleParams = 34736,
  GeoAsciiParams = 34737,
  GdalMetadata = 42112,
  GdalNoData = 42113,
}

export enum TiffCompression {
  NONE = 1,
  LZW = 5,
  JPEG = 7,
  DEFLATE = 8,
  PACKBITS = 32773,
  DEFLATE_LEGACY = 32946,
  ZSTD = 50000,
  WEBP = 50001,
}

export enum TiffSampleFormat {
  UINT = 1,
  INT = 2,
  FLOAT = 3,
}

/**
 * Reads byte ranges of a file.
 */
export interface ByteRangeReader {
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Extracts the requested byte range from a read response.  Servers that ignore the HTTP `Range`
 * header return the entire file (or a larger range), in which case the requested range is sliced
 * out.
 */
export async function getByteRangeFromResponse(
  response: { response: Response; offset: number },
  offset: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Uint8Array(await response.response.arrayBuffer());
  const start = offset - response.offset;
  if (start < 0 || start + length > data.length) {
    throw new Error(
      `Received truncated response: expected ${length} bytes at offset ${offset}, ` +
        `but received ${data.length} bytes at offset ${response.offset}`,
    );
  }
  if (start === 0 && data.length === length) return data;
  return data.slice(start, start + length);
}

/**
 * Wraps a `ByteRangeReader`, reading and caching aligned blocks.  Efficient for reading the many
 * small, nearby byte ranges that make up the image file directories.
 */
export class BlockCachingReader implements ByteRangeReader {
  private blocks = new Map<number, Promise<Uint8Array>>();

  constructor(
    private base: ByteRangeReader,
    private blockSize = 65536,
    private size: number | undefined = undefined,
  ) {}

  /**
   * Provides data already read for the block containing offset `index * blockSize`.
   */
  seedBlock(index: number, data: Uint8Array) {
    this.blocks.set(index, Promise.resolve(data));
  }

  private getBlock(index: number) {
    let block = this.blocks.get(index);
    if (block === undefined) {
      const offset = index * this.blockSize;
      let length = this.blockSize;
      if (this.size !== undefined) {
        length = Math.max(0, Math.min(length, this.size - offset));
      }
      block = this.base.read(offset, length).catch((e) => {
        this.blocks.delete(index);
        throw e;
      });
      this.blocks.set(index, block);
    }
    return block;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const { blockSize, size } = this;
    if (size !== undefined && offset + length > size) {
      throw new Error(
        `Unexpected end of file reading ${length} bytes at offset ${offset}`,
      );
    }
    const firstBlock = Math.floor(offset / blockSize);
    const lastBlock = Math.floor(
      (offset + Math.max(length, 1) - 1) / blockSize,
    );
    if (lastBlock - firstBlock > 16) {
      // Large range: read directly.
      return this.base.read(offset, length);
    }
    const blocks = await Promise.all(
      Array.from({ length: lastBlock - firstBlock + 1 }, (_, i) =>
        this.getBlock(firstBlock + i),
      ),
    );
    const result = new Uint8Array(length);
    let written = 0;
    for (let i = 0; i < blocks.length && written < length; ++i) {
      const block = blocks[i];
      const blockStart = (firstBlock + i) * blockSize;
      const start = Math.max(0, offset + written - blockStart);
      const n = Math.min(block.length - start, length - written);
      if (n <= 0) break;
      result.set(block.subarray(start, start + n), written);
      written += n;
    }
    if (written !== length) {
      throw new Error(
        `Unexpected end of file reading ${length} bytes at offset ${offset}`,
      );
    }
    return result;
  }
}

export type TiffTagValue = number[] | string | Uint8Array;

export interface TiffImageFileDirectory {
  /**
   * Raw tag values.  Numeric values are always arrays.
   */
  tags: Map<number, TiffTagValue>;
}

/**
 * Parsed properties of a TIFF image.
 */
export interface TiffImage {
  width: number;
  height: number;
  /**
   * For stripped images, the tile width equals the image width and the tile height equals the
   * number of rows per strip.
   */
  tileWidth: number;
  tileHeight: number;
  isTiled: boolean;
  samplesPerPixel: number;
  bitsPerSample: number;
  sampleFormat: TiffSampleFormat;
  compression: number;
  predictor: number;
  planarConfiguration: number;
  photometric: number;
  subfileType: number;
  /**
   * Byte offsets and lengths of each tile (or strip), ordered by sample plane (for planar
   * configuration 2), then row, then column.
   */
  offsets: number[];
  byteCounts: number[];
  jpegTables: Uint8Array | undefined;
  noData: number | undefined;
  tags: Map<number, TiffTagValue>;
}

export interface TiffFile {
  littleEndian: boolean;
  bigTiff: boolean;
  images: TiffImage[];
}

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
  16: 8, // LONG8
  17: 8, // SLONG8
  18: 8, // IFD8
};

function getUint64(view: DataView, offset: number, littleEndian: boolean) {
  const value = view.getBigUint64(offset, littleEndian);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("TIFF offset exceeds maximum supported value");
  }
  return Number(value);
}

function decodeValues(
  type: number,
  count: number,
  bytes: Uint8Array,
  littleEndian: boolean,
): TiffTagValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (type) {
    case 2: {
      let end = bytes.indexOf(0);
      if (end === -1) end = bytes.length;
      return new TextDecoder().decode(bytes.subarray(0, end));
    }
    case 7:
      return bytes.slice();
  }
  const values = new Array<number>(count);
  for (let i = 0; i < count; ++i) {
    switch (type) {
      case 1:
        values[i] = view.getUint8(i);
        break;
      case 6:
        values[i] = view.getInt8(i);
        break;
      case 3:
        values[i] = view.getUint16(2 * i, littleEndian);
        break;
      case 8:
        values[i] = view.getInt16(2 * i, littleEndian);
        break;
      case 4:
      case 13:
        values[i] = view.getUint32(4 * i, littleEndian);
        break;
      case 9:
        values[i] = view.getInt32(4 * i, littleEndian);
        break;
      case 5:
        values[i] =
          view.getUint32(8 * i, littleEndian) /
          view.getUint32(8 * i + 4, littleEndian);
        break;
      case 10:
        values[i] =
          view.getInt32(8 * i, littleEndian) /
          view.getInt32(8 * i + 4, littleEndian);
        break;
      case 11:
        values[i] = view.getFloat32(4 * i, littleEndian);
        break;
      case 12:
        values[i] = view.getFloat64(8 * i, littleEndian);
        break;
      case 16:
      case 18:
        values[i] = getUint64(view, 8 * i, littleEndian);
        break;
      case 17:
        values[i] = Number(view.getBigInt64(8 * i, littleEndian));
        break;
      default:
        throw new Error(`Unsupported TIFF field type: ${type}`);
    }
  }
  return values;
}

/**
 * Maximum number of entries in an image file directory.
 */
const MAX_IFD_ENTRIES = 65535;

/**
 * Maximum size of the value of a tag other than the tile/strip offsets and byte counts, whose
 * size is instead validated against the image dimensions.
 */
const MAX_TAG_BYTES = 16 * 1024 * 1024;

const TILE_OFFSET_TAGS = new Set<number>([
  TiffTag.StripOffsets,
  TiffTag.StripByteCounts,
  TiffTag.TileOffsets,
  TiffTag.TileByteCounts,
]);

/**
 * Computes the expected number of tiles (or strips) from the inline tag values, or returns
 * `undefined` if the dimensions are not available.
 */
function getExpectedTileCount(
  tags: Map<number, TiffTagValue>,
): number | undefined {
  const get = (tag: number) => {
    const value = tags.get(tag);
    return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
  };
  const width = get(TiffTag.ImageWidth);
  const height = get(TiffTag.ImageLength);
  if (width === undefined || height === undefined) return undefined;
  const planes =
    get(TiffTag.PlanarConfiguration) === 2
      ? (get(TiffTag.SamplesPerPixel) ?? 1)
      : 1;
  let tileWidth: number | undefined;
  let tileHeight: number | undefined;
  if (tags.has(TiffTag.TileWidth)) {
    tileWidth = get(TiffTag.TileWidth);
    tileHeight = get(TiffTag.TileLength);
  } else {
    tileWidth = width;
    tileHeight = Math.min(height, get(TiffTag.RowsPerStrip) ?? height);
  }
  if (!tileWidth || !tileHeight) return undefined;
  return Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight) * planes;
}

/**
 * Reads the entries of an image file directory.  Tag values stored outside the directory are read
 * by the returned `readTags` function.
 */
async function readImageFileDirectory(
  reader: ByteRangeReader,
  offset: number,
  littleEndian: boolean,
  bigTiff: boolean,
): Promise<{
  readTags: () => Promise<TiffImageFileDirectory>;
  nextOffset: number;
}> {
  const countSize = bigTiff ? 8 : 2;
  const entrySize = bigTiff ? 20 : 12;
  const offsetSize = bigTiff ? 8 : 4;
  const countBytes = await reader.read(offset, countSize);
  const countView = new DataView(countBytes.buffer, countBytes.byteOffset);
  const numEntries = bigTiff
    ? getUint64(countView, 0, littleEndian)
    : countView.getUint16(0, littleEndian);
  if (numEntries > MAX_IFD_ENTRIES) {
    throw new Error(
      `Invalid TIFF file: image file directory has ${numEntries} entries (maximum is ${MAX_IFD_ENTRIES})`,
    );
  }
  const entriesBytes = await reader.read(
    offset + countSize,
    numEntries * entrySize + offsetSize,
  );
  const view = new DataView(
    entriesBytes.buffer,
    entriesBytes.byteOffset,
    entriesBytes.byteLength,
  );
  const nextOffsetPosition = numEntries * entrySize;
  const nextOffset = bigTiff
    ? getUint64(view, nextOffsetPosition, littleEndian)
    : view.getUint32(nextOffsetPosition, littleEndian);
  const readTags = async () => {
    const tags = new Map<number, TiffTagValue>();
    const external: {
      tag: number;
      type: number;
      count: number;
      dataOffset: number;
      byteLength: number;
    }[] = [];
    for (let i = 0; i < numEntries; ++i) {
      const entryOffset = i * entrySize;
      const tag = view.getUint16(entryOffset, littleEndian);
      const type = view.getUint16(entryOffset + 2, littleEndian);
      const count = bigTiff
        ? getUint64(view, entryOffset + 4, littleEndian)
        : view.getUint32(entryOffset + 4, littleEndian);
      const typeSize = TYPE_SIZES[type];
      if (typeSize === undefined) continue;
      const byteLength = typeSize * count;
      const valueOffset = entryOffset + (bigTiff ? 12 : 8);
      if (byteLength <= offsetSize) {
        tags.set(
          tag,
          decodeValues(
            type,
            count,
            entriesBytes.subarray(valueOffset, valueOffset + byteLength),
            littleEndian,
          ),
        );
      } else {
        const dataOffset = bigTiff
          ? getUint64(view, valueOffset, littleEndian)
          : view.getUint32(valueOffset, littleEndian);
        external.push({ tag, type, count, dataOffset, byteLength });
      }
    }
    // Validate the sizes of values stored outside the directory before reading them, to avoid
    // huge reads for malformed files.  The image dimensions are always stored inline.
    const expectedTiles = getExpectedTileCount(tags);
    for (const { tag, count, byteLength } of external) {
      if (TILE_OFFSET_TAGS.has(tag) && expectedTiles !== undefined) {
        if (count > expectedTiles) {
          throw new Error(
            `Invalid TIFF file: tag ${tag} has ${count} values but ${expectedTiles} expected`,
          );
        }
      } else if (byteLength > MAX_TAG_BYTES) {
        throw new Error(
          `Invalid TIFF file: tag ${tag} value of ${byteLength} bytes exceeds maximum of ${MAX_TAG_BYTES} bytes`,
        );
      }
    }
    await Promise.all(
      external.map(async ({ tag, type, count, dataOffset, byteLength }) => {
        const bytes = await reader.read(dataOffset, byteLength);
        tags.set(tag, decodeValues(type, count, bytes, littleEndian));
      }),
    );
    return { tags };
  };
  return { readTags, nextOffset };
}

function getNumber(
  tags: Map<number, TiffTagValue>,
  tag: number,
  defaultValue?: number,
): number {
  const value = tags.get(tag);
  if (value === undefined) {
    if (defaultValue === undefined) {
      throw new Error(`Missing required TIFF tag ${tag}`);
    }
    return defaultValue;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid value for TIFF tag ${tag}`);
  }
  return value[0];
}

function getNumbers(tags: Map<number, TiffTagValue>, tag: number): number[] {
  const value = tags.get(tag);
  if (value === undefined) {
    throw new Error(`Missing required TIFF tag ${tag}`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid value for TIFF tag ${tag}`);
  }
  return value;
}

export function parseTiffImage(ifd: TiffImageFileDirectory): TiffImage {
  const { tags } = ifd;
  const width = getNumber(tags, TiffTag.ImageWidth);
  const height = getNumber(tags, TiffTag.ImageLength);
  if (!(width > 0 && height > 0)) {
    throw new Error(`Invalid TIFF image dimensions: ${width}x${height}`);
  }
  const samplesPerPixel = getNumber(tags, TiffTag.SamplesPerPixel, 1);
  const bitsPerSampleValues = tags.has(TiffTag.BitsPerSample)
    ? getNumbers(tags, TiffTag.BitsPerSample)
    : [1];
  const bitsPerSample = bitsPerSampleValues[0];
  if (bitsPerSampleValues.some((x) => x !== bitsPerSample)) {
    throw new Error(
      "TIFF images with differing bits per sample are not supported",
    );
  }
  const sampleFormatValues = tags.has(TiffTag.SampleFormat)
    ? getNumbers(tags, TiffTag.SampleFormat)
    : [TiffSampleFormat.UINT];
  const sampleFormat = sampleFormatValues[0] as TiffSampleFormat;
  const isTiled = tags.has(TiffTag.TileWidth);
  let tileWidth: number;
  let tileHeight: number;
  let offsets: number[];
  let byteCounts: number[];
  if (isTiled) {
    tileWidth = getNumber(tags, TiffTag.TileWidth);
    tileHeight = getNumber(tags, TiffTag.TileLength);
    offsets = getNumbers(tags, TiffTag.TileOffsets);
    byteCounts = getNumbers(tags, TiffTag.TileByteCounts);
  } else {
    tileWidth = width;
    tileHeight = Math.min(
      height,
      getNumber(tags, TiffTag.RowsPerStrip, height),
    );
    offsets = getNumbers(tags, TiffTag.StripOffsets);
    byteCounts = getNumbers(tags, TiffTag.StripByteCounts);
  }
  if (!(tileWidth > 0 && tileHeight > 0)) {
    throw new Error(`Invalid TIFF tile dimensions: ${tileWidth}x${tileHeight}`);
  }
  const planarConfiguration = getNumber(tags, TiffTag.PlanarConfiguration, 1);
  const tilesPerPlane =
    Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
  const expectedTiles =
    tilesPerPlane * (planarConfiguration === 2 ? samplesPerPixel : 1);
  if (offsets.length < expectedTiles || byteCounts.length < expectedTiles) {
    throw new Error(
      `TIFF image has ${offsets.length} tiles but ${expectedTiles} expected`,
    );
  }
  let noData: number | undefined;
  const noDataValue = tags.get(TiffTag.GdalNoData);
  if (typeof noDataValue === "string") {
    const x = Number(noDataValue.trim());
    if (!Number.isNaN(x) || noDataValue.trim().toLowerCase() === "nan") {
      noData = x;
    }
  }
  const jpegTables = tags.get(TiffTag.JPEGTables);
  return {
    width,
    height,
    tileWidth,
    tileHeight,
    isTiled,
    samplesPerPixel,
    bitsPerSample,
    sampleFormat,
    compression: getNumber(tags, TiffTag.Compression, 1),
    predictor: getNumber(tags, TiffTag.Predictor, 1),
    planarConfiguration,
    photometric: getNumber(tags, TiffTag.PhotometricInterpretation, 1),
    subfileType: getNumber(tags, TiffTag.NewSubfileType, 0),
    offsets,
    byteCounts,
    jpegTables:
      jpegTables instanceof Uint8Array
        ? jpegTables
        : Array.isArray(jpegTables)
          ? Uint8Array.from(jpegTables)
          : undefined,
    noData,
    tags,
  };
}

/**
 * Maximum number of image file directories read, as a safeguard against malformed files.
 */
const MAX_IMAGES = 1024;

/**
 * Reads the structure of a TIFF file.  Errors in the first image propagate; subsequent images
 * (overviews, masks, thumbnails, additional pages) that cannot be parsed are skipped with a
 * warning.
 */
export async function readTiff(reader: ByteRangeReader): Promise<TiffFile> {
  const header = await reader.read(0, 16);
  let littleEndian: boolean;
  if (header[0] === 0x49 && header[1] === 0x49) {
    littleEndian = true;
  } else if (header[0] === 0x4d && header[1] === 0x4d) {
    littleEndian = false;
  } else {
    throw new Error("Not a TIFF file: invalid byte order mark");
  }
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  const version = view.getUint16(2, littleEndian);
  let bigTiff: boolean;
  let offset: number;
  if (version === 42) {
    bigTiff = false;
    offset = view.getUint32(4, littleEndian);
  } else if (version === 43) {
    bigTiff = true;
    if (view.getUint16(4, littleEndian) !== 8) {
      throw new Error("Unsupported BigTIFF offset size");
    }
    offset = getUint64(view, 8, littleEndian);
  } else {
    throw new Error(`Not a TIFF file: invalid version ${version}`);
  }
  const images: TiffImage[] = [];
  const seen = new Set<number>();
  for (let index = 0; offset !== 0; ++index) {
    let readTags: () => Promise<TiffImageFileDirectory>;
    try {
      if (seen.has(offset) || index >= MAX_IMAGES) {
        throw new Error("Invalid TIFF file: cyclic image file directories");
      }
      seen.add(offset);
      let nextOffset: number;
      ({ readTags, nextOffset } = await readImageFileDirectory(
        reader,
        offset,
        littleEndian,
        bigTiff,
      ));
      offset = nextOffset;
    } catch (e) {
      if (index === 0) throw e;
      // The chain of image file directories cannot be followed further.
      console.warn(`Ignoring TIFF image file directories from #${index}:`, e);
      break;
    }
    try {
      images.push(parseTiffImage(await readTags()));
    } catch (e) {
      if (index === 0) throw e;
      console.warn(`Ignoring TIFF image #${index}:`, e);
    }
  }
  if (images.length === 0) {
    throw new Error("TIFF file contains no images");
  }
  return { littleEndian, bigTiff, images };
}

/**
 * Detects TIFF and BigTIFF files from their first 4 bytes.
 */
export function isTiffHeader(prefix: Uint8Array) {
  if (prefix.length < 4) return false;
  const [a, b, c, d] = prefix;
  return (
    (a === 0x49 && b === 0x49 && (c === 42 || c === 43) && d === 0) ||
    (a === 0x4d && b === 0x4d && c === 0 && (d === 42 || d === 43))
  );
}
