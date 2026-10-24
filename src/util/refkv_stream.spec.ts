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

import { describe, expect, test } from "vitest";
import type { ChunkPlanes } from "#src/util/refkv_stream.js";
import {
  avcCodecString,
  copyPicture,
  narrowRange,
  newChunkPlanes,
  parseStreamChunk,
  SharedPlanes,
  streamColor,
} from "#src/util/refkv_stream.js";

// A chunk of three frames of 2, 200 and 3 bytes at positions -1, 1 and 0 (the
// header refkv writes: count, then each size and zigzag position delta), as
// refkv's Python parser reads it.
const fromBase64 = (b: string) =>
  Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

// avcC payloads: SLEAP's test video (Main profile; its VUI says limited range
// and the BT.601 matrix, H.273 code 6), and refkv's mp4_h264_bframes.mp4 (High
// profile, no colour description)
const SLEAP_AVCC = fromBase64(
  "AU1AH//hAB9nTUAf7KDAY3/gF+AXrUGAQZAAAAMAEAAr8gDxgxlgAQAEaO+E8g==",
);
const BFRAMES_AVCC = fromBase64(
  "AWQACv/hABhnZAAKrNlEewEQAAADABAAAAMBQPEiWWABAAZo6+PLIsD9+PgA",
);

function chunk(): Uint8Array<ArrayBuffer> {
  const frames = [
    Uint8Array.from([0x61, 0x62]),
    Uint8Array.from({ length: 200 }, (_, i) => i),
    Uint8Array.from([0x78, 0x79, 0x7a]),
  ];
  const header = [3, 2, 0, 200, 1, 4, 3, 1];
  const out = new Uint8Array(header.length + 205);
  out.set(header);
  let at = header.length;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

describe("refkv.stream", () => {
  test("reads chunks, codec strings and pictures, and shares planes", async () => {
    const { units, positions } = parseStreamChunk(chunk());
    expect(positions).toEqual([-1, 1, 0]);
    expect(units.map((u) => u.length)).toEqual([2, 200, 3]);
    expect(Array.from(units[2])).toEqual([0x78, 0x79, 0x7a]);
    expect(units[1][199]).toBe(199);

    // High profile, no constraint flags, level 4.0; Main at 3.0
    expect(avcCodecString(Uint8Array.from([1, 0x64, 0x00, 0x28, 0xff]))).toBe(
      "avc1.640028",
    );
    expect(avcCodecString(Uint8Array.from([1, 0x4d, 0x40, 0x1e]))).toBe(
      "avc1.4d401e",
    );

    // a 3 x 2 picture (chroma 2 x 1) with row padding, as I420 and as NV12,
    // at position 1 of a 2-picture chunk
    for (const [format, src, layout] of [
      [
        "I420",
        Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 0, 9, 10, 0]),
        [
          { offset: 0, stride: 4 },
          { offset: 8, stride: 3 },
          { offset: 11, stride: 3 },
        ],
      ],
      [
        "NV12",
        Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 9, 8, 10, 0]),
        [
          { offset: 0, stride: 4 },
          { offset: 8, stride: 5 },
        ],
      ],
    ] as const) {
      const planes = newChunkPlanes(2, 3, 2);
      copyPicture(format, src, layout, planes, 1);
      expect(Array.from(planes.data.y!)).toEqual([
        0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6,
      ]);
      expect(Array.from(planes.data.u!)).toEqual([0, 0, 7, 8]);
      expect(Array.from(planes.data.v!)).toEqual([0, 0, 9, 10]);
    }

    // RGB pictures (Firefox's VideoDecoder gives BGRX) converted back by
    // their color space, the chroma of each 2 x 2 block its pixels' mean: red,
    // green, blue and gray in BT.601 (no matrix given) and limited range; red
    // as RGBX in BT.709 and full range
    const rgb = newChunkPlanes(2, 2, 2);
    copyPicture(
      "BGRX",
      Uint8Array.from([
        0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 128, 128, 128, 0,
      ]),
      [{ offset: 0, stride: 8 }],
      rgb,
      0,
    );
    copyPicture(
      "RGBX",
      Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
      [{ offset: 0, stride: 8 }],
      rgb,
      1,
      { matrix: "bt709", fullRange: true },
    );
    expect(Array.from(rgb.data.y!)).toEqual([81, 145, 41, 126, 54, 54, 54, 54]);
    expect(Array.from(rgb.data.u!)).toEqual([128, 99]);
    expect(Array.from(rgb.data.v!)).toEqual([128, 255]);

    // the stream's colour signalling, from its SPS's VUI
    expect(streamColor(SLEAP_AVCC)).toEqual({
      fullRange: false,
      matrix: "smpte170m",
    });
    expect(streamColor(BFRAMES_AVCC)).toEqual({ fullRange: false });

    // full-range planes (WebKit's, for a limited-range stream) narrowed back
    const wide = newChunkPlanes(1, 2, 2);
    wide.data.y!.set([0, 255, 128, 16]);
    wide.data.u!.set([0]);
    wide.data.v!.set([255]);
    narrowRange(wide, 0);
    expect(Array.from(wide.data.y!)).toEqual([16, 235, 126, 30]);
    expect([wide.data.u![0], wide.data.v![0]]).toEqual([16, 240]);

    // the planes not asked for are kept, given once each, within the limit
    const shared = new SharedPlanes(16);
    let runs = 0;
    const decode = (n: number) => async (): Promise<ChunkPlanes> => {
      runs += 1;
      return {
        frames: 1,
        shapes: { y: [1, n], u: [1, n], v: [1, n] },
        data: {
          y: new Uint8Array(n),
          u: new Uint8Array(n),
          v: new Uint8Array(n),
        },
      };
    };
    const a = Uint8Array.from([1, 2, 3]);
    // Y and U at once: one decoding
    const [y, u] = await Promise.all([
      shared.take("s", a, "y", decode(4)),
      shared.take("s", a, "u", decode(4)),
    ]);
    expect([y.length, u.length, runs]).toEqual([4, 4, 1]);
    await shared.take("s", a, "v", decode(4));
    expect([runs, shared.size]).toEqual([1, 0]);
    // given once: decoded again; another stream's setup is another chunk
    await shared.take("s", a, "v", decode(4));
    await shared.take("t", a, "y", decode(4));
    expect([runs, shared.size, shared.bytes()]).toEqual([3, 2, 16]);
    // past 16 bytes: the oldest dropped; planes larger than the limit not kept
    await shared.take("s", Uint8Array.from([4]), "y", decode(4));
    expect([shared.size, shared.bytes()]).toEqual([2, 16]);
    await shared.take("s", Uint8Array.from([5]), "y", decode(9));
    expect(shared.size).toBe(2);
  });

  test("rejects a header that ends inside a varint", () => {
    expect(() => parseStreamChunk(Uint8Array.from([3, 0x80]))).toThrow(
      "ends inside a varint",
    );
  });

  test("rejects frames whose sizes do not sum to the chunk", () => {
    expect(() => parseStreamChunk(chunk().subarray(0, 100))).toThrow(
      "the frames' sizes sum to 205, not the chunk's 92",
    );
  });

  test("rejects a setup that is not an avcC payload", () => {
    expect(() =>
      avcCodecString(Uint8Array.from([0x67, 0x64, 0, 0x28])),
    ).toThrow("not an avcC box's payload");
  });

  test("rejects a picture that is not 8-bit 4:2:0", () => {
    expect(() =>
      copyPicture("I444", new Uint8Array(18), [], newChunkPlanes(1, 3, 2), 0),
    ).toThrow("decodes to I444, not 8-bit 4:2:0 or RGB");
  });

  test("rejects a picture outside the chunk", () => {
    expect(() =>
      copyPicture("I420", new Uint8Array(14), [], newChunkPlanes(1, 3, 2), 1),
    ).toThrow("a picture at 1 is outside the chunk's 1");
  });
});
