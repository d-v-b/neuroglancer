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
 * @file Lossless JPEG decoding: ITU-T T.81 process 14, the Huffman-coded
 * lossless process of Annex H, whose frames start with the SOF3 marker. It
 * supports predictors 1 to 7, a point transform, sample precisions of 2 to 16
 * bits, 1 to 4 components interleaved in a single scan without subsampling,
 * and restart intervals; APPn, COM and other segments are skipped. Samples
 * are returned as stored, without color conversion. Arithmetic coding
 * (SOF11), hierarchical frames and multiple scans are not supported.
 */

export interface DecodedLosslessJpeg {
  width: number;
  height: number;
  numComponents: number;
  // Sample precision P, 2 to 16 bits.
  bitsPerSample: number;
  // Samples interleaved as [height, width, components]: 8-bit for P <= 8,
  // 16-bit otherwise.
  data: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;
}

// Codes of up to FAST_BITS bits are decoded with one table lookup.
const FAST_BITS = 9;

interface HuffmanTable {
  // Indexed by the next FAST_BITS bits: (code length << 8) | symbol, or 0 if
  // the code is longer.
  fast: Uint16Array;
  // Indexed by code length: the largest code of that length, or -1.
  maxCode: Int32Array;
  // Indexed by code length: index into `symbols` of a code of that length,
  // minus the code.
  symbolOffset: Int32Array;
  symbols: Uint8Array;
}

function makeHuffmanTable(counts: Uint8Array, symbols: Uint8Array) {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxCode = new Int32Array(18).fill(-1);
  const symbolOffset = new Int32Array(18);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; ++length) {
    const n = counts[length - 1];
    symbolOffset[length] = k - code;
    for (let i = 0; i < n; ++i, ++k, ++code) {
      if (length <= FAST_BITS) {
        const shift = FAST_BITS - length;
        fast.fill(
          (length << 8) | symbols[k],
          code << shift,
          (code + 1) << shift,
        );
      }
    }
    if (code > 1 << length) {
      throw new Error("Lossless JPEG: invalid Huffman table");
    }
    if (n !== 0) maxCode[length] = code - 1;
    code <<= 1;
  }
  return { fast, maxCode, symbolOffset, symbols };
}

function readUint16(data: Uint8Array, pos: number) {
  return (data[pos] << 8) | data[pos + 1];
}

const SOF_NAMES: Record<number, string> = {
  0xc0: "baseline DCT",
  0xc1: "extended sequential DCT",
  0xc2: "progressive DCT",
  0xc5: "differential sequential DCT",
  0xc6: "differential progressive DCT",
  0xc7: "differential lossless",
  0xc9: "arithmetic-coded sequential DCT",
  0xca: "arithmetic-coded progressive DCT",
  0xcb: "arithmetic-coded lossless",
  0xcd: "arithmetic-coded differential sequential DCT",
  0xce: "arithmetic-coded differential progressive DCT",
  0xcf: "arithmetic-coded differential lossless",
};

interface Frame {
  precision: number;
  height: number;
  width: number;
  componentIds: number[];
}

/**
 * Decodes one lossless JPEG (SOF3) stream.
 */
export function decodeLosslessJpeg(data: Uint8Array): DecodedLosslessJpeg {
  const end = data.length;
  if (end < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("Lossless JPEG: data does not start with an SOI marker");
  }
  const tables: (HuffmanTable | undefined)[] = [];
  let frame: Frame | undefined;
  let restartInterval = 0;
  let pos = 2;
  while (true) {
    if (pos >= end || data[pos] !== 0xff) {
      throw new Error(`Lossless JPEG: expected a marker at byte ${pos}`);
    }
    while (data[pos] === 0xff) ++pos;
    const marker = data[pos++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0xd9 || pos === end) {
      throw new Error("Lossless JPEG: data ends before a scan");
    }
    if (pos + 2 > end) break;
    const length = readUint16(data, pos);
    const segmentEnd = pos + length;
    if (length < 2 || segmentEnd > end) break;
    const segment = pos + 2;
    pos = segmentEnd;
    if (marker === 0xc3) {
      if (frame !== undefined) {
        throw new Error("Lossless JPEG: more than one frame");
      }
      frame = parseFrame(data, segment, segmentEnd);
    } else if (marker in SOF_NAMES) {
      throw new Error(
        `Lossless JPEG: the frame is ${SOF_NAMES[marker]} (SOF${marker - 0xc0}), not lossless (SOF3)`,
      );
    } else if (marker === 0xc4) {
      parseHuffmanTables(data, segment, segmentEnd, tables);
    } else if (marker === 0xdd) {
      if (length !== 4) break;
      restartInterval = readUint16(data, segment);
    } else if (marker === 0xda) {
      if (frame === undefined) {
        throw new Error("Lossless JPEG: scan before the SOF3 frame");
      }
      return decodeScan(
        data,
        segment,
        segmentEnd,
        frame,
        tables,
        restartInterval,
      );
    }
    // Other segments (APPn, COM, DQT, DNL, ...) are skipped.
  }
  throw new Error("Lossless JPEG: truncated marker segment");
}

function parseFrame(data: Uint8Array, pos: number, end: number): Frame {
  const numComponents = data[pos + 5];
  if (end - pos !== 6 + 3 * numComponents) {
    throw new Error("Lossless JPEG: invalid SOF3 segment");
  }
  const precision = data[pos];
  const height = readUint16(data, pos + 1);
  const width = readUint16(data, pos + 3);
  if (precision < 2 || precision > 16) {
    throw new Error(
      `Lossless JPEG: unsupported sample precision ${precision} (2 to 16 bits are supported)`,
    );
  }
  if (height === 0 || width === 0) {
    throw new Error(
      `Lossless JPEG: unsupported image size ${width} x ${height}`,
    );
  }
  if (numComponents === 0) {
    throw new Error("Lossless JPEG: frame has no components");
  }
  const componentIds: number[] = [];
  for (let i = 0; i < numComponents; ++i) {
    const p = pos + 6 + 3 * i;
    componentIds.push(data[p]);
    if (numComponents > 1 && data[p + 1] !== 0x11) {
      throw new Error(
        `Lossless JPEG: subsampled components (sampling factors ${data[p + 1] >> 4}x${data[p + 1] & 15}) are not supported`,
      );
    }
  }
  return { precision, height, width, componentIds };
}

function parseHuffmanTables(
  data: Uint8Array,
  pos: number,
  end: number,
  tables: (HuffmanTable | undefined)[],
) {
  while (pos < end) {
    if (pos + 17 > end) break;
    const tableClass = data[pos] >> 4;
    const id = data[pos] & 15;
    const counts = data.subarray(pos + 1, pos + 17);
    let n = 0;
    for (let i = 0; i < 16; ++i) n += counts[i];
    pos += 17;
    if (pos + n > end || id > 3) break;
    // Lossless scans use DC (class 0) tables only.
    if (tableClass === 0) {
      tables[id] = makeHuffmanTable(counts, data.subarray(pos, pos + n));
    }
    pos += n;
  }
  if (pos !== end) {
    throw new Error("Lossless JPEG: invalid DHT segment");
  }
}

function decodeScan(
  data: Uint8Array,
  pos: number,
  segmentEnd: number,
  frame: Frame,
  tables: (HuffmanTable | undefined)[],
  restartInterval: number,
): DecodedLosslessJpeg {
  const { precision, height, width, componentIds } = frame;
  const numComponents = componentIds.length;
  const ns = data[pos];
  if (segmentEnd - pos !== 4 + 2 * ns) {
    throw new Error("Lossless JPEG: invalid SOS segment");
  }
  if (ns !== numComponents) {
    throw new Error(
      `Lossless JPEG: the scan has ${ns} of the frame's ${numComponents} components; multiple scans are not supported`,
    );
  }
  // For each scan component, in scan order: its index in the frame (and so in
  // a pixel of the output) and its Huffman table.
  const componentIndex: number[] = [];
  const componentTables: HuffmanTable[] = [];
  for (let j = 0; j < ns; ++j) {
    const id = data[pos + 1 + 2 * j];
    const k = componentIds.indexOf(id);
    if (k === -1 || componentIndex.includes(k)) {
      throw new Error(`Lossless JPEG: invalid scan component ${id}`);
    }
    const tableId = data[pos + 2 + 2 * j] >> 4;
    const table = tables[tableId];
    if (table === undefined) {
      throw new Error(`Lossless JPEG: Huffman table ${tableId} is not defined`);
    }
    componentIndex.push(k);
    componentTables.push(table);
  }
  const predictor = data[pos + 1 + 2 * ns];
  const pointTransform = data[pos + 3 + 2 * ns] & 15;
  if (predictor < 1 || predictor > 7) {
    throw new Error(
      `Lossless JPEG: unsupported predictor ${predictor} (1 to 7 are supported)`,
    );
  }
  if (pointTransform >= precision) {
    throw new Error(
      `Lossless JPEG: point transform ${pointTransform} is not less than the precision ${precision}`,
    );
  }
  // In lossless mode a restart interval is a whole number of rows (T.81
  // H.1.1): each one restarts the prediction as the first row does.
  let rowsPerInterval = height;
  if (restartInterval !== 0) {
    if (restartInterval % width !== 0) {
      throw new Error(
        `Lossless JPEG: restart interval ${restartInterval} is not a multiple of the width ${width}`,
      );
    }
    rowsPerInterval = restartInterval / width;
  }

  const stride = width * numComponents;
  const out =
    precision <= 8
      ? new Uint8Array(height * stride)
      : new Uint16Array(height * stride);
  const initialPrediction = 1 << (precision - pointTransform - 1);

  // Entropy-coded data, read most significant bit first. After a marker
  // (or the end of the data) zero bits are supplied, and counted in
  // `paddingBits` so that reading into them is reported.
  const end = data.length;
  pos = segmentEnd;
  let bitBuffer = 0;
  let bitCount = 0;
  let paddingBits = 0;
  let atMarker = false;
  const fill = () => {
    while (bitCount <= 24) {
      let byte = 0;
      if (!atMarker && pos < end) {
        byte = data[pos];
        if (byte === 0xff) {
          if (data[pos + 1] === 0) {
            pos += 2;
          } else {
            atMarker = true;
            byte = 0;
            paddingBits += 8;
          }
        } else {
          ++pos;
        }
      } else {
        paddingBits += 8;
      }
      bitBuffer = (bitBuffer << 8) | byte;
      bitCount += 8;
    }
  };
  const checkNotTruncated = () => {
    if (bitCount < paddingBits) {
      throw new Error("Lossless JPEG: data ends before the scan does");
    }
  };
  const decodeDifference = (table: HuffmanTable) => {
    if (bitCount < 16) fill();
    const entry =
      table.fast[
        (bitBuffer >>> (bitCount - FAST_BITS)) & ((1 << FAST_BITS) - 1)
      ];
    let s: number;
    if (entry !== 0) {
      bitCount -= entry >> 8;
      s = entry & 0xff;
    } else {
      const { maxCode } = table;
      let length = FAST_BITS + 1;
      let code = (bitBuffer >>> (bitCount - length)) & ((1 << length) - 1);
      while (code > maxCode[length]) {
        if (++length > 16) {
          throw new Error("Lossless JPEG: invalid Huffman code");
        }
        code = (bitBuffer >>> (bitCount - length)) & ((1 << length) - 1);
      }
      bitCount -= length;
      s = table.symbols[code + table.symbolOffset[length]];
    }
    if (s === 0) return 0;
    if (s === 16) return 32768;
    if (s > 16) {
      throw new Error(`Lossless JPEG: invalid difference category ${s}`);
    }
    if (bitCount < s) fill();
    const v = (bitBuffer >>> (bitCount - s)) & ((1 << s) - 1);
    bitCount -= s;
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  };

  for (let y = 0; y < height; ++y) {
    const rowInInterval = y % rowsPerInterval;
    if (rowInInterval === 0 && y !== 0) {
      checkNotTruncated();
      // Discard the interval's padding bits and read its RSTn marker.
      const isMarker = data[pos] === 0xff;
      while (data[pos] === 0xff) ++pos;
      const marker = data[pos++];
      if (!isMarker || !(marker >= 0xd0 && marker <= 0xd7)) {
        throw new Error(
          `Lossless JPEG: expected a restart marker before row ${y}`,
        );
      }
      bitBuffer = 0;
      bitCount = 0;
      paddingBits = 0;
      atMarker = false;
    }
    const rowStart = y * stride;
    for (let x = 0; x < width; ++x) {
      const pixel = rowStart + x * numComponents;
      for (let j = 0; j < ns; ++j) {
        const i = pixel + componentIndex[j];
        const diff = decodeDifference(componentTables[j]);
        let prediction: number;
        if (rowInInterval === 0) {
          prediction = x === 0 ? initialPrediction : out[i - numComponents];
        } else if (x === 0) {
          prediction = out[i - stride];
        } else {
          const a = out[i - numComponents];
          const b = out[i - stride];
          const c = out[i - stride - numComponents];
          switch (predictor) {
            case 1:
              prediction = a;
              break;
            case 2:
              prediction = b;
              break;
            case 3:
              prediction = c;
              break;
            case 4:
              prediction = a + b - c;
              break;
            case 5:
              prediction = a + ((b - c) >> 1);
              break;
            case 6:
              prediction = b + ((a - c) >> 1);
              break;
            default:
              prediction = (a + b) >> 1;
              break;
          }
        }
        out[i] = (prediction + diff) & 0xffff;
      }
    }
  }
  checkNotTruncated();
  if (pointTransform !== 0) {
    for (let i = 0; i < out.length; ++i) out[i] <<= pointTransform;
  }
  return {
    width,
    height,
    numComponents,
    bitsPerSample: precision,
    data: out,
  };
}
