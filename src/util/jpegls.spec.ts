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

import { describe, expect, test } from "vitest";
import { decodeJpegLs } from "#src/util/jpegls.js";
import vectors from "#src/util/jpegls.spec.vectors.json";

// Streams that imagecodecs (CharLS) wrote, and frames of pydicom's test files,
// with the CRC-32 of the samples imagecodecs decodes from each: lossless and
// near-lossless, 7 to 16 bits, and each of the three interleave modes.
const VECTORS: Record<
  string,
  { b64: string; shape: number[]; bytes: number; crc: number }
> = vectors;

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; ++k) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

describe("decodeJpegLs", () => {
  test.each(Object.keys(VECTORS))("%s", (name) => {
    const { b64, shape, bytes, crc } = VECTORS[name];
    const { width, height, numComponents, data } = decodeJpegLs(
      fromBase64(b64),
    );
    expect([
      height,
      width,
      ...(numComponents > 1 ? [numComponents] : []),
    ]).toEqual(shape);
    expect(data.BYTES_PER_ELEMENT).toBe(bytes);
    expect(
      crc32(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    ).toBe(crc);
  });

  test("refuses a stream without SOI", () => {
    expect(() => decodeJpegLs(new Uint8Array(4))).toThrow(
      "does not start with SOI",
    );
  });

  test("refuses restart intervals", () => {
    const dri = Uint8Array.of(0xff, 0xd8, 0xff, 0xdd, 0, 4, 0, 8);
    expect(() => decodeJpegLs(dri)).toThrow("restart intervals");
  });

  test("refuses a sample mapping table", () => {
    const lse = Uint8Array.of(0xff, 0xd8, 0xff, 0xf8, 0, 3, 2);
    expect(() => decodeJpegLs(lse)).toThrow("an LSE segment of type 2");
  });
});
