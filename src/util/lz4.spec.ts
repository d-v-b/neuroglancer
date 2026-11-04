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

import { expect, test } from "vitest";
import { decodeLz4Block } from "#src/util/lz4.js";

const block = (...bytes: number[]) => Uint8Array.from(bytes);

test("decodes literals, long lengths and overlapping matches", () => {
  // token 0x40: 4 literals, then the end of the block
  expect(Array.from(decodeLz4Block(block(0x40, 1, 2, 3, 4), 4))).toEqual([
    1, 2, 3, 4,
  ]);
  // one literal, then a match of offset 1 and 4 + 2 bytes, overlapping itself
  expect(
    Array.from(decodeLz4Block(block(0x12, 7, 1, 0, 0x00), 7)),
  ).toEqual([7, 7, 7, 7, 7, 7, 7]);
  // a literal length of 15 + 1
  const literals = Array.from({ length: 16 }, (_, i) => i);
  expect(
    Array.from(decodeLz4Block(block(0xf0, 1, ...literals), 16)),
  ).toEqual(literals);
  // an empty block
  expect(decodeLz4Block(block(0x00), 0).length).toBe(0);
});

test("rejects a truncated length", () => {
  expect(() => decodeLz4Block(block(0xf0), 16)).toThrow(/inside a length/);
});

test("rejects literals past the block", () => {
  expect(() => decodeLz4Block(block(0x40, 1), 4)).toThrow(/literals past/);
});

test("rejects literals past the output", () => {
  expect(() => decodeLz4Block(block(0x20, 1, 2), 1)).toThrow(/literals past/);
});

test("rejects a truncated offset", () => {
  expect(() => decodeLz4Block(block(0x10, 1, 1), 4)).toThrow(/inside an offset/);
});

test("rejects an offset of zero", () => {
  expect(() => decodeLz4Block(block(0x10, 1, 0, 0), 5)).toThrow(/an offset of 0/);
});

test("rejects an offset before the output", () => {
  expect(() => decodeLz4Block(block(0x10, 1, 2, 0), 5)).toThrow(/an offset of 2/);
});

test("rejects a match past the output", () => {
  expect(() => decodeLz4Block(block(0x10, 1, 1, 0), 2)).toThrow(/match past/);
});

test("rejects a block shorter than the output", () => {
  expect(() => decodeLz4Block(block(0x10, 1), 2)).toThrow(/1 bytes decoded/);
});
