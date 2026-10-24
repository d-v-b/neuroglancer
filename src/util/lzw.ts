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
 * @file TIFF LZW decoding (TIFF 6.0 section 13, as libtiff writes it): codes
 * of 9 to 12 bits packed most significant bit first, a Clear code of 256 and an
 * end-of-information code of 257, new table entries from 258, and the "early
 * change" every TIFF writer uses (the code width grows one code before the
 * table fills the current width). The pre-TIFF-5.0 variant with codes packed
 * least significant bit first is not supported.
 */

const CLEAR = 256;
const EOI = 257;
const FIRST = 258;
const MAX_CODE = 4096;

/**
 * Decodes one TIFF LZW stream. With `size`, the decoded size the stream is
 * expected to have, decoding stops once the output reaches it, whatever
 * follows: some scanners write the final code one bit too narrow, so that a
 * decoder reading on sees one more table entry, or an invalid code. Without
 * it, the whole stream is decoded (the output grows as needed).
 */
export function decodeTiffLzw(
  encoded: Uint8Array,
  size?: number,
): Uint8Array<ArrayBuffer> {
  const sizeHint = size ?? encoded.length * 4;
  // The string table: each entry is its prefix entry plus one byte; a root
  // entry (a single byte) has prefix -1.
  const prefix = new Int32Array(MAX_CODE);
  const suffix = new Uint8Array(MAX_CODE);
  const firstByte = new Uint8Array(MAX_CODE);
  const length = new Uint32Array(MAX_CODE);
  for (let i = 0; i < 256; ++i) {
    prefix[i] = -1;
    suffix[i] = i;
    firstByte[i] = i;
    length[i] = 1;
  }
  let out = new Uint8Array(Math.max(16, sizeHint));
  let outLength = 0;
  const ensure = (n: number) => {
    if (outLength + n <= out.length) return;
    let size = out.length * 2;
    while (size < outLength + n) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, outLength));
    out = bigger;
  };
  // Writes entry `code`, from its last byte back to its first.
  const emit = (code: number) => {
    const n = length[code];
    ensure(n);
    let p = outLength + n - 1;
    for (let c = code; c >= 0; c = prefix[c]) out[p--] = suffix[c];
    outLength += n;
  };
  let next = FIRST;
  let width = 9;
  let prev = -1;
  let bits = 0;
  let bitCount = 0;
  let pos = 0;
  const n = encoded.length;
  for (;;) {
    while (bitCount < width) {
      if (pos >= n) {
        // A stream may end without an EOI code.
        return out.subarray(0, outLength).slice();
      }
      bits = ((bits << 8) | encoded[pos++]) >>> 0;
      bitCount += 8;
    }
    if (size !== undefined && outLength >= size) break;
    const code = (bits >>> (bitCount - width)) & ((1 << width) - 1);
    bitCount -= width;
    bits &= (1 << bitCount) - 1;
    if (code === CLEAR) {
      next = FIRST;
      width = 9;
      prev = -1;
      continue;
    }
    if (code === EOI) break;
    let first: number;
    if (code < next) {
      first = firstByte[code];
      emit(code);
    } else if (code === next && prev !== -1) {
      // The entry being defined: the previous string followed by its own
      // first byte.
      first = firstByte[prev];
      emit(prev);
      ensure(1);
      out[outLength++] = first;
    } else {
      throw new Error(`Invalid LZW code ${code} at byte ${pos}`);
    }
    if (prev !== -1 && next < MAX_CODE) {
      prefix[next] = prev;
      suffix[next] = first;
      firstByte[next] = firstByte[prev];
      length[next] = length[prev] + 1;
      ++next;
      // Early change: the width grows when the table reaches 2^width - 1.
      if (next + 1 === 1 << width && width < 12) ++width;
    }
    prev = code;
  }
  if (size !== undefined && outLength > size) outLength = size;
  return out.subarray(0, outLength).slice();
}
