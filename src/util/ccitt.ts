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
 * @file CCITT Group 4 decoding ([ITU-T T.6](https://www.itu.int/rec/T-REC-T.6)):
 * two-dimensional coding of bilevel rows, each against the row before it, the
 * first against an imaginary white row, with the run-length codes of ITU-T T.4
 * for horizontal mode, packed most significant bit first (TIFF's FillOrder 1).
 * The extensions of T.6, among them uncompressed mode, are not supported.
 *
 * A stream that ends before its last row is an error, as is a row that does not
 * move strictly rightward, which T.6 does not allow. (imagecodecs instead leaves
 * the remaining rows white, and decodes such rows to something.) Whatever follows
 * the last row, such as the end-of-facsimile-block code and fill bits, is ignored.
 */

// The bit strings of the run-length codes of T.4, table 2.
const WHITE_TERMINATING =
  "00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100";
const BLACK_TERMINATING =
  "0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111";
// Runs of 64, 128, ... 1728.
const WHITE_MAKEUP =
  "11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011";
const BLACK_MAKEUP =
  "0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101";
// Runs of 1792, 1856, ... 2560, of either color (T.4, table 3).
const COMMON_MAKEUP =
  "00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111";

// The longest run-length code.
const MAX_CODE_BITS = 13;

// Indexed by the next MAX_CODE_BITS bits of the stream: (code length << 12) |
// run, or 0 for no code. A run of 0 has a nonzero length, so is not 0.
function makeRunTable(terminating: string, makeup: string) {
  const table = new Uint16Array(1 << MAX_CODE_BITS);
  const add = (codes: string, firstRun: number, runStep: number) => {
    codes.split(" ").forEach((code, i) => {
      const first = parseInt(code, 2) << (MAX_CODE_BITS - code.length);
      table.fill(
        (code.length << 12) | (firstRun + i * runStep),
        first,
        first + (1 << (MAX_CODE_BITS - code.length)),
      );
    });
  };
  add(terminating, 0, 1);
  add(makeup, 64, 64);
  add(COMMON_MAKEUP, 1792, 64);
  return table;
}

// Indexed by a run's color: 0 white, 1 black.
const RUN_TABLES = [
  makeRunTable(WHITE_TERMINATING, WHITE_MAKEUP),
  makeRunTable(BLACK_TERMINATING, BLACK_MAKEUP),
];

/**
 * Decodes one stream to `height` rows of `width` samples, 1 for black and 0
 * for white.
 */
export function decodeCcittGroup4(
  encoded: Uint8Array,
  height: number,
  width: number,
): Uint8Array<ArrayBuffer> {
  const decoded = new Uint8Array(height * width);
  const numBits = encoded.length * 8;
  let position = 0;

  // The next 16 bits of the stream, 0 after its end. Only the bits a code then
  // consumes must exist, which `consume` checks.
  const peek16 = () => {
    const byte = position >>> 3;
    return (
      (((encoded[byte] << 16) |
        (encoded[byte + 1] << 8) |
        encoded[byte + 2]) >>>
        (8 - (position & 7))) &
      0xffff
    );
  };
  const consume = (n: number) => {
    position += n;
    if (position > numBits) {
      throw new Error(
        `imagecodecs_ccittfax4: the stream of ${encoded.length} bytes ends ` +
          "before the image does",
      );
    }
  };

  // A run of `color`: any number of makeup codes, then a terminating code.
  const readRun = (color: number) => {
    const table = RUN_TABLES[color];
    let total = 0;
    while (true) {
      const entry = table[peek16() >>> (16 - MAX_CODE_BITS)];
      if (entry === 0) {
        throw new Error(
          `imagecodecs_ccittfax4: invalid ${color === 0 ? "white" : "black"} ` +
            `run code at bit ${position}`,
        );
      }
      consume(entry >>> 12);
      const run = entry & 0xfff;
      total += run;
      if (run < 64) return total;
    }
  };

  // Changing elements: the positions where a row changes color, starting from
  // white, so that those at even indices start black runs. Those of each row
  // are followed by `width`, so that `b1` and `b2` always exist. Positions
  // strictly increase but for a final run of 0 pixels, so that a row has at most
  // `width + 2` of them: 0 to `width`, and `width` again.
  const maxChanges = width + 2;
  let reference = new Int32Array(maxChanges + 3).fill(width);
  let current = new Int32Array(maxChanges + 3);

  const invalidChange = (a0: number, a1: number, y: number) =>
    new Error(
      `imagecodecs_ccittfax4: row ${y} changes color at ${a1}, after ` +
        `reaching ${a0} of a width of ${width}`,
    );

  for (let y = 0; y < height; ++y) {
    // The imaginary changing element before the first pixel, which `b1` of the
    // first pixel may be at.
    let a0 = -1;
    let color = 0;
    let numCurrent = 0;
    let referenceIndex = 0;
    while (a0 < width) {
      // b1: the first changing element of the reference row to the right of
      // a0 and to the color opposite a0's, which is at an index of parity
      // `color`. A vertical mode can move a0 left of the b1 last found, so that
      // the search steps back first.
      referenceIndex = Math.max(0, referenceIndex - 2);
      if ((referenceIndex & 1) !== color) ++referenceIndex;
      while (
        reference[referenceIndex] <= a0 &&
        reference[referenceIndex] < width
      ) {
        referenceIndex += 2;
      }
      const b1 = reference[referenceIndex];

      const bits = peek16();
      let a1: number;
      let codeBits: number;
      if (bits >= 0x8000) {
        // V0
        a1 = b1;
        codeBits = 1;
      } else if (bits >>> 13 === 0b011) {
        a1 = b1 + 1;
        codeBits = 3;
      } else if (bits >>> 13 === 0b010) {
        a1 = b1 - 1;
        codeBits = 3;
      } else if (bits >>> 13 === 0b001) {
        // Horizontal mode: a run of the current color, then of the other. Their
        // start is the first pixel when a0 is imaginary. The first run is empty
        // only for a row that starts black, and the second only at the row's end.
        consume(3);
        const start = Math.max(a0, 0);
        const firstEnd = start + readRun(color);
        if (firstEnd > width || (firstEnd === start && a0 >= 0)) {
          throw invalidChange(a0, firstEnd, y);
        }
        const secondEnd = firstEnd + readRun(color ^ 1);
        if (
          secondEnd > width ||
          (secondEnd === firstEnd && firstEnd !== width)
        ) {
          throw invalidChange(firstEnd, secondEnd, y);
        }
        current[numCurrent++] = firstEnd;
        current[numCurrent++] = secondEnd;
        a0 = secondEnd;
        continue;
      } else if (bits >>> 12 === 0b0001) {
        // Pass mode: a0 moves under b2, and the color goes on.
        consume(4);
        a0 = reference[referenceIndex + 1];
        continue;
      } else if (bits >>> 10 === 0b000011) {
        a1 = b1 + 2;
        codeBits = 6;
      } else if (bits >>> 10 === 0b000010) {
        a1 = b1 - 2;
        codeBits = 6;
      } else if (bits >>> 9 === 0b0000011) {
        a1 = b1 + 3;
        codeBits = 7;
      } else if (bits >>> 9 === 0b0000010) {
        a1 = b1 - 3;
        codeBits = 7;
      } else {
        // An extension, the end-of-facsimile-block code, or no code at all.
        if (position >= numBits || bits >>> 4 === 1) {
          throw new Error(
            `imagecodecs_ccittfax4: the stream ends at row ${y} of an image ` +
              `of ${height} rows`,
          );
        }
        throw new Error(
          `imagecodecs_ccittfax4: unsupported or invalid mode code at bit ${position}`,
        );
      }
      consume(codeBits);
      if (a1 <= a0 || a1 > width) throw invalidChange(a0, a1, y);
      current[numCurrent++] = a1;
      a0 = a1;
      color ^= 1;
    }

    const row = decoded.subarray(y * width, (y + 1) * width);
    for (let i = 0; i < numCurrent; i += 2) {
      row.fill(1, current[i], i + 1 < numCurrent ? current[i + 1] : width);
    }
    current.fill(width, numCurrent, numCurrent + 3);
    [reference, current] = [current, reference];
  }
  return decoded;
}
