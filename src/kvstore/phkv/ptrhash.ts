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
 * @file The perfect hash of a phkv store (phkv spec §18
 * <https://github.com/d-v-b/refkv/blob/main/spec/bindings/phkv.md#18-perfect-hash>): PtrHash's
 * query (parts, buckets, one byte of pilot per bucket) with XXH64 as the key hash and a slot
 * table in place of PtrHash's remap. `slot` is the query §18.3 defines. A port of the query of
 * refkv's js/src/ptrhash.ts, without the writer's pilot search.
 *
 * A 64-bit value is held as two uint32 halves, as BigInt arithmetic would be slow.
 */

import { xxh64 } from "#src/kvstore/phkv/xxh64.js";

export interface Params {
  seed: bigint;
  parts: number;
  slots: number;
  buckets: number;
}

const TWO32 = 4294967296;

// the pilot multiplier 0x517CC1B727220A95 and MurmurHash3's finalizer constants, in halves
const PILOT_HI = 0x517cc1b7;
const PILOT_LO = 0x27220a95;
const C1_HI = 0xff51afd7;
const C1_LO = 0xed558ccd;
const C2_HI = 0xc4ceb9fe;
const C2_LO = 0x1a85ec53;

// the high word of the last `mul32`, and the halves of the last `fmix`
let H = 0;
let OH = 0;
let OL = 0;

/** The low word of the 64-bit product `a * b` of two uint32; its high word is left in `H`. */
function mul32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const mid = a0 * b1 + a1 * b0;
  const lo = a0 * b0 + (mid % 65536) * 65536;
  H = a1 * b1 + Math.floor(mid / 65536) + Math.floor(lo / TWO32);
  return lo >>> 0;
}

/** `(xh, xl) * (ch, cl)` modulo 2^64, into OH, OL. */
function mulWrap(xh: number, xl: number, ch: number, cl: number): void {
  const lo = mul32(xl, cl);
  OL = lo;
  OH = (H + Math.imul(xh, cl) + Math.imul(xl, ch)) >>> 0;
}

/** MurmurHash3's 64-bit finalizer of `(xh, xl)`, into OH, OL. */
function fmix(xh: number, xl: number): void {
  xl = (xl ^ (xh >>> 1)) >>> 0;
  mulWrap(xh, xl, C1_HI, C1_LO);
  xh = OH;
  xl = (OL ^ (xh >>> 1)) >>> 0;
  mulWrap(xh, xl, C2_HI, C2_LO);
  xh = OH;
  OL = (OL ^ (xh >>> 1)) >>> 0;
}

/** `mulhi((xh, xl), m)` for `m` below 2^32: `x` scaled from [0, 2^64) to [0, m). */
function mulhi(xh: number, xl: number, m: number): number {
  mul32(xl, m);
  const p1h = H;
  const p2l = mul32(xh, m);
  return H + (p2l + p1h >= TWO32 ? 1 : 0);
}

/** `(xh, xl) * m` modulo 2^64 for `m` below 2^32, into OH, OL. */
function mulSmallWrap(xh: number, xl: number, m: number): void {
  const lo = mul32(xl, m);
  const p1h = H;
  const p2l = mul32(xh, m);
  OL = lo;
  OH = (p1h + p2l) >>> 0;
}

// pilot × the multiplier, for each of the 256 pilots
const PILOT_HIS = new Uint32Array(256);
const PILOT_LOS = new Uint32Array(256);
for (let p = 0; p < 256; p++) {
  mulWrap(0, p, PILOT_HI, PILOT_LO);
  PILOT_HIS[p] = OH;
  PILOT_LOS[p] = OL;
}

const hi = (h: bigint) => Number(h >> 32n);
const lo = (h: bigint) => Number(h & 0xffffffffn);

/** The part of a hash, and its bucket's index among all buckets (the index of its pilot). */
function bucket(params: Params, hh: number, hl: number): number {
  const p = mulhi(hh, hl, params.parts);
  mulSmallWrap(hh, hl, params.parts);
  return p * params.buckets + mulhi(OH, OL, params.buckets);
}

/** The slot of a hash within its part, given the pilot of its bucket. */
function slotInPart(
  params: Params,
  hh: number,
  hl: number,
  pilot: number,
): number {
  fmix((hh ^ PILOT_HIS[pilot]) >>> 0, (hl ^ PILOT_LOS[pilot]) >>> 0);
  return mulhi(OH, OL, params.slots);
}

/** The slot of the key whose hash is `h`, among `params.parts * params.slots` (spec §18.3). */
export function slot(params: Params, pilots: Uint8Array, h: bigint): number {
  const hh = hi(h);
  const hl = lo(h);
  const p = mulhi(hh, hl, params.parts);
  const b = bucket(params, hh, hl);
  return p * params.slots + slotInPart(params, hh, hl, pilots[b]);
}

/** The XXH64 of a key's UTF-8 bytes, with the store's seed. */
export const hash = (key: Uint8Array, seed: bigint): bigint => xxh64(key, seed);
