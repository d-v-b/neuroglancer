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
 * @file A decoder of bzip2 (a file of one or more streams), which browsers do not
 * have: `DecompressionStream` reads gzip and deflate alone. It checks every
 * block's and stream's CRC, and rejects the deprecated randomized blocks.
 */

const BLOCK_MAGIC = 0x314159265359;
const END_MAGIC = 0x177245385090;
const MAX_CODE_LENGTH = 20;
const GROUP_SYMBOLS = 50;
const RUNA = 0;
const RUNB = 1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c < 0 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c >>> 0;
  }
  return table;
})();

class Bits {
  private at = 0;
  private bit = 0;
  constructor(private data: Uint8Array) {}

  /** The next `n` bits, most significant first; `n` is at most 48. */
  read(n: number): number {
    let value = 0;
    for (let left = n; left > 0; ) {
      if (this.at >= this.data.length) {
        throw new Error("bzip2: the stream ends early");
      }
      const take = Math.min(left, 8 - this.bit);
      const part =
        (this.data[this.at] >> (8 - this.bit - take)) & ((1 << take) - 1);
      value = value * (1 << take) + part;
      left -= take;
      this.bit += take;
      if (this.bit === 8) {
        this.bit = 0;
        this.at++;
      }
    }
    return value;
  }

  /** The next bit: `read(1)`, for the code bits, which are nearly all of a stream. */
  next(): number {
    if (this.at >= this.data.length) {
      throw new Error("bzip2: the stream ends early");
    }
    const value = (this.data[this.at] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) {
      this.bit = 0;
      this.at++;
    }
    return value;
  }

  /** To the next byte; whether any byte is left. */
  align(): boolean {
    if (this.bit !== 0) {
      this.bit = 0;
      this.at++;
    }
    return this.at < this.data.length;
  }
}

class Output {
  private bytes: Uint8Array<ArrayBuffer>;
  length = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
  }

  /** Room for `n` more bytes, at `this.length` of the returned array. */
  reserve(n: number): Uint8Array<ArrayBuffer> {
    if (this.length + n > this.bytes.length) {
      const grown = new Uint8Array(
        Math.max(this.bytes.length * 2, this.length + n),
      );
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    }
    return this.bytes;
  }

  finished(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length);
  }
}

/** A code's tables, by length: canonical codes, as bzip2 assigns them. */
function huffman(lengths: Uint8Array, symbols: number) {
  const limit = new Int32Array(MAX_CODE_LENGTH + 2);
  const base = new Int32Array(MAX_CODE_LENGTH + 2);
  const perm = new Int32Array(symbols);
  let at = 0;
  let code = 0;
  for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
    base[length] = code - at;
    for (let s = 0; s < symbols; s++) {
      if (lengths[s] === length) {
        perm[at++] = s;
        code++;
      }
    }
    limit[length] = code;
    code *= 2;
  }
  return { limit, base, perm };
}

function readBlock(bits: Bits, capacity: number, output: Output): number {
  const expected = bits.read(32);
  if (bits.read(1) !== 0) {
    throw new Error("bzip2: a randomized block is not supported");
  }
  const origin = bits.read(24);
  const used: number[] = [];
  const ranges = bits.read(16);
  for (let i = 0; i < 16; i++) {
    if (ranges & (0x8000 >> i)) {
      const present = bits.read(16);
      for (let j = 0; j < 16; j++) {
        if (present & (0x8000 >> j)) used.push(i * 16 + j);
      }
    }
  }
  if (used.length === 0) throw new Error("bzip2: a block of no symbols");
  const symbols = used.length + 2;
  const end = symbols - 1;
  const groups = bits.read(3);
  const selectorCount = bits.read(15);
  if (groups < 2 || groups > 6 || selectorCount < 1) {
    throw new Error("bzip2: a block's coding tables are not valid");
  }
  const order = Array.from({ length: groups }, (_, i) => i);
  const selectors = new Uint8Array(selectorCount);
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (bits.read(1) === 1) {
      if (++j >= groups) throw new Error("bzip2: a selector is not valid");
    }
    const [chosen] = order.splice(j, 1);
    order.unshift(chosen);
    selectors[i] = chosen;
  }
  const tables = [];
  for (let t = 0; t < groups; t++) {
    const lengths = new Uint8Array(symbols);
    let length = bits.read(5);
    for (let s = 0; s < symbols; s++) {
      for (;;) {
        if (length < 1 || length > MAX_CODE_LENGTH) {
          throw new Error("bzip2: a code length is not valid");
        }
        if (bits.read(1) === 0) break;
        length += bits.read(1) === 0 ? 1 : -1;
      }
      lengths[s] = length;
    }
    tables.push(huffman(lengths, symbols));
  }

  // the symbols: move-to-front indexes with runs of the first, into the last column
  const column = new Uint8Array(capacity);
  const counts = new Int32Array(256);
  const front = Uint8Array.from(used);
  let count = 0;
  let run = 0;
  let runBit = 1;
  let group = 0;
  let left = 0;
  let table = tables[selectors[0]];
  const flush = () => {
    if (run === 0) return;
    if (count + run > capacity) throw new Error("bzip2: a block is too long");
    const value = front[0];
    column.fill(value, count, count + run);
    counts[value] += run;
    count += run;
    run = 0;
    runBit = 1;
  };
  for (;;) {
    if (left === 0) {
      if (group >= selectorCount) {
        throw new Error("bzip2: a block runs past its selectors");
      }
      table = tables[selectors[group++]];
      left = GROUP_SYMBOLS;
    }
    left--;
    let length = 1;
    let code = bits.next();
    while (length <= MAX_CODE_LENGTH && code >= table.limit[length]) {
      code = code * 2 + bits.next();
      length++;
    }
    if (length > MAX_CODE_LENGTH) {
      throw new Error("bzip2: a code is not valid");
    }
    const symbol = table.perm[code - table.base[length]];
    if (symbol === RUNA || symbol === RUNB) {
      run += runBit * (symbol + 1);
      runBit *= 2;
      if (run > capacity) throw new Error("bzip2: a block is too long");
      continue;
    }
    flush();
    if (symbol === end) break;
    if (count >= capacity) throw new Error("bzip2: a block is too long");
    const value = front[symbol - 1];
    front.copyWithin(1, 0, symbol - 1);
    front[0] = value;
    column[count++] = value;
    counts[value]++;
  }
  if (origin >= count) throw new Error("bzip2: a block's origin is not valid");

  // the inverse Burrows-Wheeler transform
  const next = new Uint32Array(count);
  const starts = new Int32Array(256);
  for (let i = 1; i < 256; i++) starts[i] = starts[i - 1] + counts[i - 1];
  for (let i = 0; i < count; i++) next[starts[column[i]]++] = i;

  // the run-length coding, and the CRC of what it gives
  let at = next[origin];
  let crc = 0xffffffff | 0;
  let repeated = 0;
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const byte = column[at];
    at = next[at];
    let times = 1;
    let value = byte;
    if (repeated === 4) {
      times = byte;
      value = previous;
      repeated = 0;
    } else if (byte === previous) {
      repeated++;
    } else {
      repeated = 1;
      previous = byte;
    }
    const out = output.reserve(times);
    for (let k = 0; k < times; k++) {
      out[output.length++] = value;
      crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ value) & 0xff];
    }
  }
  const computed = ~crc >>> 0;
  if (computed !== expected) throw new Error("bzip2: a block's CRC differs");
  return computed;
}

/** The bytes a file of bzip2 streams decodes to. */
export function decodeBzip2(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bits = new Bits(data);
  const output = new Output(Math.max(data.length * 4, 1024));
  do {
    if (bits.read(24) !== 0x425a68) throw new Error("bzip2: not a stream");
    const level = bits.read(8) - 0x30;
    if (level < 1 || level > 9) throw new Error("bzip2: not a stream");
    let combined = 0;
    for (;;) {
      const magic = bits.read(48);
      if (magic === END_MAGIC) break;
      if (magic !== BLOCK_MAGIC) throw new Error("bzip2: not a block");
      const crc = readBlock(bits, level * 100000, output);
      combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    }
    if (bits.read(32) !== combined) {
      throw new Error("bzip2: a stream's CRC differs");
    }
  } while (bits.align());
  return output.finished();
}
