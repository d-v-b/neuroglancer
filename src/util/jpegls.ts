/**
 * @license
 * Copyright 2023 Google Inc.
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
 * @file A JPEG-LS (ISO/IEC 14495-1, ITU-T T.87) decoder: lossless and
 * near-lossless, 2 to 16 bits, one to four components, in every interleave
 * mode. It follows the standard's Annex A, with CharLS's order of operations.
 * Restart intervals and sample mapping tables are refused.
 */

export interface DecodedJpegLs {
  width: number;
  height: number;
  numComponents: number;
  /** The samples, interleaved by component, row-major. */
  data: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;
}

const J = [
  0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 9,
  10, 11, 12, 13, 14, 15,
];
const NUM_CONTEXTS = 365;
const MIN_C = -128;
const MAX_C = 127;

interface Params {
  maxVal: number;
  t1: number;
  t2: number;
  t3: number;
  reset: number;
}

function clamp(v: number, lo: number, hi: number) {
  return v > hi || v < lo ? lo : v;
}

function defaultParams(maxVal: number, near: number): Params {
  if (maxVal >= 128) {
    const f = Math.floor((Math.min(maxVal, 4095) + 128) / 256);
    const t1 = clamp(f * (3 - 2) + 2 + 3 * near, near + 1, maxVal);
    const t2 = clamp(f * (7 - 3) + 3 + 5 * near, t1, maxVal);
    const t3 = clamp(f * (21 - 4) + 4 + 7 * near, t2, maxVal);
    return { maxVal, t1, t2, t3, reset: 64 };
  }
  const f = Math.floor(256 / (maxVal + 1));
  const t1 = clamp(Math.max(2, Math.floor(3 / f) + 3 * near), near + 1, maxVal);
  const t2 = clamp(Math.max(3, Math.floor(7 / f) + 5 * near), t1, maxVal);
  const t3 = clamp(Math.max(4, Math.floor(21 / f) + 7 * near), t2, maxVal);
  return { maxVal, t1, t2, t3, reset: 64 };
}

/** The scan's bits, without the zero bit stuffed after each FF byte. */
class BitReader {
  private word = 0;
  private count = 0;
  constructor(
    private data: Uint8Array,
    public position: number,
  ) {}

  private fill() {
    const { data } = this;
    const prior = this.position > 0 ? data[this.position - 1] : 0;
    let byte = this.position < data.length ? data[this.position] : 0;
    if (prior === 0xff && byte >= 0x80) {
      // A marker: the scan's bits have ended, and what is asked for is padding.
      byte = 0;
    } else {
      ++this.position;
    }
    const bits = prior === 0xff ? 7 : 8;
    this.word = ((this.word << bits) | byte) & 0xffffff;
    this.count += bits;
  }

  readBit(): number {
    if (this.count === 0) this.fill();
    --this.count;
    return (this.word >>> this.count) & 1;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; ++i) v = (v << 1) | this.readBit();
    return v >>> 0;
  }
}

interface RunContext {
  a: number;
  n: number;
  nn: number;
  type: number;
}

class Scan {
  private a: Int32Array;
  private b: Int32Array;
  private c: Int32Array;
  private n: Int32Array;
  private run: RunContext[];
  private range: number;
  private qbpp: number;
  private limit: number;
  private step: number;
  public runIndex = 0;

  constructor(
    private bits: BitReader,
    private params: Params,
    private near: number,
  ) {
    const { maxVal } = params;
    this.step = 2 * near + 1;
    this.range = Math.floor((maxVal + 2 * near) / this.step) + 1;
    this.qbpp = Math.ceil(Math.log2(this.range));
    const bpp = Math.max(2, Math.ceil(Math.log2(maxVal + 1)));
    this.limit = 2 * (bpp + Math.max(8, bpp));
    const initial = Math.max(2, Math.floor((this.range + 32) / 64));
    this.a = new Int32Array(NUM_CONTEXTS).fill(initial);
    this.b = new Int32Array(NUM_CONTEXTS);
    this.c = new Int32Array(NUM_CONTEXTS);
    this.n = new Int32Array(NUM_CONTEXTS).fill(1);
    this.run = [
      { a: initial, n: 1, nn: 0, type: 0 },
      { a: initial, n: 1, nn: 0, type: 1 },
    ];
  }

  private quantize(d: number): number {
    const { t1, t2, t3 } = this.params;
    const { near } = this;
    if (d <= -t3) return -4;
    if (d <= -t2) return -3;
    if (d <= -t1) return -2;
    if (d < -near) return -1;
    if (d <= near) return 0;
    if (d < t1) return 1;
    if (d < t2) return 2;
    if (d < t3) return 3;
    return 4;
  }

  context(ra: number, rb: number, rc: number, rd: number): number {
    return (
      81 * this.quantize(rd - rb) +
      9 * this.quantize(rb - rc) +
      this.quantize(rc - ra)
    );
  }

  private reconstruct(v: number): number {
    const { near, range, step } = this;
    const { maxVal } = this.params;
    if (v < -near) v += range * step;
    else if (v > maxVal + near) v -= range * step;
    return v < 0 ? 0 : v > maxVal ? maxVal : v;
  }

  private mapped(k: number, limit: number): number {
    const { bits, qbpp } = this;
    let high = 0;
    while (bits.readBit() === 0) {
      if (++high > limit)
        throw new Error("jpegls: a code longer than its limit");
    }
    if (high >= limit - (qbpp + 1)) return bits.read(qbpp) + 1;
    return k === 0 ? high : high * 2 ** k + bits.read(k);
  }

  regular(q: number, ra: number, rb: number, rc: number): number {
    const sign = q < 0 ? -1 : 1;
    const i = q * sign;
    const { a, b, c, n, near, step, params } = this;
    const lo = Math.min(ra, rb);
    const hi = Math.max(ra, rb);
    const predicted = rc >= hi ? lo : rc <= lo ? hi : ra + rb - rc;
    let px = predicted + sign * c[i];
    px = px < 0 ? 0 : px > params.maxVal ? params.maxVal : px;
    let k = 0;
    for (let t = n[i]; t < a[i]; t *= 2) ++k;
    const m = this.mapped(k, this.limit);
    let error = m % 2 === 0 ? m / 2 : -(m + 1) / 2;
    if (k === 0 && near === 0 && 2 * b[i] + n[i] - 1 < 0) error = -error - 1;
    // The context's update
    let nb = b[i] + error * step;
    let na = a[i] + Math.abs(error);
    let nn = n[i];
    if (nn === params.reset) {
      na >>= 1;
      nb >>= 1;
      nn >>= 1;
    }
    ++nn;
    if (nb + nn <= 0) {
      nb += nn;
      if (nb <= -nn) nb = -nn + 1;
      if (c[i] > MIN_C) --c[i];
    } else if (nb > 0) {
      nb -= nn;
      if (nb > 0) nb = 0;
      if (c[i] < MAX_C) ++c[i];
    }
    a[i] = na;
    b[i] = nb;
    n[i] = nn;
    return this.reconstruct(px + sign * error * step);
  }

  /** The pixels of a run of at most `remaining`. */
  runLength(remaining: number): number {
    const { bits } = this;
    let index = 0;
    while (bits.readBit() === 1) {
      const whole = 1 << J[this.runIndex];
      const count = Math.min(whole, remaining - index);
      index += count;
      if (count === whole && this.runIndex < 31) ++this.runIndex;
      if (index === remaining) return index;
    }
    const left = J[this.runIndex];
    if (left > 0) index += bits.read(left);
    if (index > remaining) throw new Error("jpegls: a run past its line");
    return index;
  }

  private interruption(context: RunContext): number {
    const { reset } = this.params;
    const temp = context.a + (context.n >> 1) * context.type;
    let k = 0;
    for (let t = context.n; t < temp; t *= 2) ++k;
    const m = this.mapped(k, this.limit - J[this.runIndex] - 1);
    const value = m + context.type;
    const odd = value & 1;
    const magnitude = (value + odd) / 2;
    const negative = (k !== 0 || 2 * context.nn >= context.n) === (odd === 1);
    const error = negative ? -magnitude : magnitude;
    if (error < 0) ++context.nn;
    context.a += (m + 1 - context.type) >> 1;
    if (context.n === reset) {
      context.a >>= 1;
      context.n >>= 1;
      context.nn >>= 1;
    }
    ++context.n;
    return error;
  }

  /** The sample that ends a run, of one component. */
  interrupted(ra: number, rb: number): number {
    const { near, step } = this;
    if (Math.abs(ra - rb) <= near) {
      return this.reconstruct(ra + this.interruption(this.run[1]) * step);
    }
    const sign = rb - ra < 0 ? -1 : 1;
    return this.reconstruct(rb + sign * this.interruption(this.run[0]) * step);
  }

  /** One of a pixel's samples that end a run of several components. */
  interruptedComponent(ra: number, rb: number): number {
    const sign = rb - ra < 0 ? -1 : 1;
    return this.reconstruct(
      rb + sign * this.interruption(this.run[0]) * this.step,
    );
  }

  endRun() {
    if (this.runIndex > 0) --this.runIndex;
  }
}

/** Decodes one component's line. `cur` and `prev` hold samples from index 1. */
function decodeLine(
  scan: Scan,
  cur: Int32Array,
  prev: Int32Array,
  width: number,
) {
  let x = 1;
  const end = width + 1;
  while (x < end) {
    const ra = cur[x - 1];
    const rc = prev[x - 1];
    const rb = prev[x];
    const rd = prev[x + 1];
    const q = scan.context(ra, rb, rc, rd);
    if (q !== 0) {
      cur[x++] = scan.regular(q, ra, rb, rc);
      continue;
    }
    const run = scan.runLength(end - x);
    cur.fill(ra, x, x + run);
    x += run;
    if (x === end) return;
    cur[x] = scan.interrupted(ra, prev[x]);
    ++x;
    scan.endRun();
  }
}

/**
 * Decodes one line of `numComponents` components interleaved by sample. `cur`
 * and `prev` hold pixels from index 1, each of `numComponents` samples.
 */
function decodeSampleLine(
  scan: Scan,
  cur: Int32Array,
  prev: Int32Array,
  width: number,
  numComponents: number,
) {
  const c = numComponents;
  let x = 1;
  const end = width + 1;
  const contexts = new Int32Array(c);
  while (x < end) {
    let zero = true;
    for (let k = 0; k < c; ++k) {
      const q = scan.context(
        cur[(x - 1) * c + k],
        prev[x * c + k],
        prev[(x - 1) * c + k],
        prev[(x + 1) * c + k],
      );
      contexts[k] = q;
      if (q !== 0) zero = false;
    }
    if (!zero) {
      for (let k = 0; k < c; ++k) {
        const ra = cur[(x - 1) * c + k];
        const rb = prev[x * c + k];
        const rc = prev[(x - 1) * c + k];
        const q = contexts[k];
        // A sample whose gradients are flat is coded in context 0.
        cur[x * c + k] = scan.regular(q, ra, rb, rc);
      }
      ++x;
      continue;
    }
    const run = scan.runLength(end - x);
    for (let i = 0; i < run; ++i) {
      for (let k = 0; k < c; ++k) {
        cur[(x + i) * c + k] = cur[(x - 1) * c + k];
      }
    }
    x += run;
    if (x === end) return;
    for (let k = 0; k < c; ++k) {
      cur[x * c + k] = scan.interruptedComponent(
        cur[(x - 1) * c + k],
        prev[x * c + k],
      );
    }
    ++x;
    scan.endRun();
  }
}

interface Frame {
  precision: number;
  height: number;
  width: number;
  numComponents: number;
}

export function decodeJpegLs(data: Uint8Array): DecodedJpegLs {
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("jpegls: the stream does not start with SOI");
  }
  let frame: Frame | undefined;
  let preset: Partial<Params> = {};
  let out: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | undefined;
  let scans = 0;
  let p = 2;
  for (;;) {
    while (data[p] === 0xff && data[p + 1] === 0xff) ++p;
    if (p + 2 > data.length || data[p] !== 0xff) {
      throw new Error(`jpegls: no marker at byte ${p}`);
    }
    const marker = data[p + 1];
    if (marker === 0xd9) break;
    const length = (data[p + 2] << 8) | data[p + 3];
    const body = p + 4;
    switch (marker) {
      case 0xf7:
        frame = {
          precision: data[body],
          height: (data[body + 1] << 8) | data[body + 2],
          width: (data[body + 3] << 8) | data[body + 4],
          numComponents: data[body + 5],
        };
        break;
      case 0xf8: {
        const id = data[body];
        if (id !== 1) {
          throw new Error(
            `jpegls: an LSE segment of type ${id} is not supported`,
          );
        }
        const u16 = (k: number) =>
          (data[body + 1 + 2 * k] << 8) | data[body + 2 + 2 * k];
        preset = {
          maxVal: u16(0),
          t1: u16(1),
          t2: u16(2),
          t3: u16(3),
          reset: u16(4),
        };
        break;
      }
      case 0xdd:
        if (((data[body] << 8) | data[body + 1]) !== 0) {
          throw new Error("jpegls: restart intervals are not supported");
        }
        break;
      case 0xda: {
        if (frame === undefined) throw new Error("jpegls: a scan before SOF55");
        const { width, height, numComponents, precision } = frame;
        if (out === undefined) {
          const n = width * height * numComponents;
          out = precision > 8 ? new Uint16Array(n) : new Uint8Array(n);
        }
        const ns = data[body];
        const near = data[body + 1 + 2 * ns];
        const ilv = data[body + 2 + 2 * ns];
        const shift = data[body + 3 + 2 * ns] & 0xf;
        if (shift !== 0) {
          throw new Error("jpegls: a point transform is not supported");
        }
        if (ilv === 0 ? ns !== 1 : ns !== numComponents) {
          throw new Error(
            `jpegls: a scan of ${ns} components in interleave mode ${ilv}`,
          );
        }
        const maxVal = preset.maxVal || 2 ** precision - 1;
        const defaults = defaultParams(maxVal, near);
        const params: Params = {
          maxVal,
          t1: preset.t1 || defaults.t1,
          t2: preset.t2 || defaults.t2,
          t3: preset.t3 || defaults.t3,
          reset: preset.reset || defaults.reset,
        };
        const bits = new BitReader(data, p + 2 + length);
        const scan = new Scan(bits, params, near);
        decodeScan(scan, out, frame, ilv, scans);
        ++scans;
        // The next marker, after the scan's last byte
        p = bits.position;
        if (p > 0 && data[p - 1] === 0xff) --p;
        while (
          p + 1 < data.length &&
          !(data[p] === 0xff && data[p + 1] >= 0x80)
        ) {
          ++p;
        }
        continue;
      }
    }
    p += 2 + length;
  }
  if (frame === undefined || out === undefined) {
    throw new Error("jpegls: the stream has no scan");
  }
  return {
    width: frame.width,
    height: frame.height,
    numComponents: frame.numComponents,
    data: out,
  };
}

function decodeScan(
  scan: Scan,
  out: Uint8Array | Uint16Array,
  frame: Frame,
  ilv: number,
  scanIndex: number,
) {
  const { width, height, numComponents: c } = frame;
  if (ilv === 2) {
    let prev = new Int32Array((width + 2) * c);
    let cur = new Int32Array((width + 2) * c);
    for (let y = 0; y < height; ++y) {
      for (let k = 0; k < c; ++k) {
        prev[(width + 1) * c + k] = prev[width * c + k];
        cur[k] = prev[c + k];
      }
      decodeSampleLine(scan, cur, prev, width, c);
      const row = y * width * c;
      for (let i = 0; i < width * c; ++i) out[row + i] = cur[c + i];
      [prev, cur] = [cur, prev];
    }
    return;
  }
  // Line interleaved, or one component a scan: each component's own lines, and
  // its own run index.
  const components = ilv === 1 ? c : 1;
  const lines = Array.from({ length: components }, () => [
    new Int32Array(width + 2),
    new Int32Array(width + 2),
  ]);
  const runIndex = new Array<number>(components).fill(0);
  for (let y = 0; y < height; ++y) {
    for (let k = 0; k < components; ++k) {
      const pair = lines[k];
      const [prev, cur] = pair;
      prev[width + 1] = prev[width];
      cur[0] = prev[1];
      scan.runIndex = runIndex[k];
      decodeLine(scan, cur, prev, width);
      runIndex[k] = scan.runIndex;
      const component = ilv === 1 ? k : scanIndex;
      const row = y * width * c + component;
      for (let i = 0; i < width; ++i) out[row + i * c] = cur[i + 1];
      pair[0] = cur;
      pair[1] = prev;
    }
  }
}
