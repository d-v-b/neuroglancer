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
  base64Bytes,
  copyFlacSamples,
  copyPicture,
  flacStream,
  mp3Stream,
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

  test("reads an mp3 stream from a Layer III frame's header", () => {
    // the version, sample rate and channel mode bits of each version
    for (const [header, stream] of [
      // MPEG-1, 44100 Hz, stereo
      [
        [0xff, 0xfb, 0x90, 0x00],
        [44100, 2, 1152],
      ],
      // MPEG-1, 32000 Hz, mono, with a CRC
      [
        [0xff, 0xfa, 0x98, 0xc0],
        [32000, 1, 1152],
      ],
      // MPEG-2, 16000 Hz, joint stereo
      [
        [0xff, 0xf3, 0x48, 0x40],
        [16000, 2, 576],
      ],
      // MPEG-2.5, 8000 Hz, mono
      [
        [0xff, 0xe3, 0x18, 0xc0],
        [8000, 1, 576],
      ],
    ] as const) {
      const { sampleRate, channels, samplesPerFrame } = mp3Stream(
        Uint8Array.from(header),
      );
      expect([sampleRate, channels, samplesPerFrame]).toEqual(stream);
    }
  });

  test("rejects an mp3 frame without a sync", () => {
    expect(() => mp3Stream(Uint8Array.from([0xff, 0x1b, 0x90, 0]))).toThrow(
      "does not start with a sync",
    );
  });

  test("rejects an mp3 frame of the reserved version", () => {
    expect(() => mp3Stream(Uint8Array.from([0xff, 0xeb, 0x90, 0]))).toThrow(
      "version is reserved",
    );
  });

  test("rejects an mp3 frame that is not Layer III", () => {
    expect(() => mp3Stream(Uint8Array.from([0xff, 0xfd, 0x90, 0]))).toThrow(
      "is Layer II, not Layer III",
    );
  });

  test("rejects an mp3 frame of the reserved layer", () => {
    expect(() => mp3Stream(Uint8Array.from([0xff, 0xf9, 0x90, 0]))).toThrow(
      "is of a reserved layer, not Layer III",
    );
  });

  test("rejects an mp3 frame of the invalid sample rate index", () => {
    expect(() => mp3Stream(Uint8Array.from([0xff, 0xfb, 0x9c, 0]))).toThrow(
      "sample rate index is invalid",
    );
  });

  test("reads a flac stream's STREAMINFO", () => {
    // refkv's fixtures' setups, against refkv's python/tests/ir/test_flac.py
    for (const [setup, stream] of [
      // flac_mono_16
      [
        "ZkxhQ4AAACIEAAQAAAQyAAUZA+gA8AAAH0BgPGM/L5AWonufOnS9+BTZ",
        [16000, 1, 16, 1024],
      ],
      // flac_bitwise_8
      [
        "ZkxhQ4AAACIAQABAAAAAAAAAAfQAcAAAAZAi9OiyvIHmzDLpcKt0fJDl",
        [8000, 1, 8, 64],
      ],
      // flac_bitwise_32
      [
        "ZkxhQ4AAACIAwADAAAAAAAAACsRD8AAAAbmMwI8Da+uvgU3sy3nCGK1m",
        [44100, 2, 32, 192],
      ],
      // flac_mono_24
      [
        "ZkxhQ4AAACIQABAAAAYpACM0F3ABcAAAEsChPpOIPDN8+CXdVCS6Z2Wd",
        [96000, 1, 24, 4096],
      ],
      // flac_bitwise_uncommon
      [
        "ZkxhQ4AAACIAZABkAAAAAAAAArEQ8AAAAifsoSfXxRgVe4WiTAiN6a79",
        [11025, 1, 16, 100],
      ],
      // flac_stereo_24
      [
        "ZkxhQ4AAACIEgASAABQWABQwC7gDcAAAFoDoOUnieUphG8KLMrbUOIrF",
        [48000, 2, 24, 1152],
      ],
    ] as const) {
      const { sampleRate, channels, bitsPerSample, blockSize } = flacStream(
        base64Bytes(setup),
      );
      expect([sampleRate, channels, bitsPerSample, blockSize]).toEqual(stream);
    }
  });

  test("rejects a flac setup that is not fLaC and a STREAMINFO block", () => {
    const setup = base64Bytes(
      "ZkxhQ4AAACIEAAQAAAQyAAUZA+gA8AAAH0BgPGM/L5AWonufOnS9+BTZ",
    );
    for (const bad of [
      setup.subarray(0, 41),
      Uint8Array.from(setup, (b, i) => (i === 0 ? 0x66 + 1 : b)),
      Uint8Array.from(setup, (b, i) => (i === 4 ? 0x84 : b)),
      Uint8Array.from(setup, (b, i) => (i === 7 ? 33 : b)),
    ]) {
      expect(() => flacStream(bad)).toThrow(
        "a flac setup is fLaC and a STREAMINFO block, 42 bytes",
      );
    }
  });

  test("copies a decoder's flac samples back to the stream's integers", () => {
    // [format, the decoder's samples (a plane a channel when planar), the
    // stream's bits]: two rows of two channels, -3 and 5, then 7 and -1,
    // placed at row 1 of 3
    const cases: [string, ArrayLike<number>[], number][] = [
      // ffmpeg's 16 bits of an 8-bit stream, interleaved
      ["s16", [Int16Array.from([-3 << 8, 5 << 8, 7 << 8, -1 << 8])], 8],
      // 24 bits in the top of 32, a plane a channel
      [
        "s32-planar",
        [
          Int32Array.from([-3 << 8, 7 << 8]),
          Int32Array.from([5 << 8, -1 << 8]),
        ],
        24,
      ],
      // 32 bits, all of them
      ["s32", [Int32Array.from([-3, 5, 7, -1])], 32],
      // unsigned 8 bits of a 4-bit stream
      ["u8", [Uint8Array.from([128 - 48, 128 + 80, 128 + 112, 128 - 16])], 4],
      // floats of a 16-bit stream, scaled to [-1, 1), and of a 24-bit one
      [
        "f32-planar",
        [
          Float32Array.from([-3 / 32768, 7 / 32768]),
          Float32Array.from([5 / 32768, -1 / 32768]),
        ],
        16,
      ],
      ["f32", [Float32Array.from([-3, 5, 7, -1].map((v) => v / 2 ** 23))], 24],
    ];
    for (const [format, data, bits] of cases) {
      const out = new Int32Array(6);
      data.forEach((d, c) =>
        copyFlacSamples(
          format,
          d,
          2,
          out,
          1,
          2,
          data.length > 1 ? c : undefined,
          bits,
        ),
      );
      expect([format, Array.from(out)]).toEqual([format, [0, 0, -3, 5, 7, -1]]);
    }
    // a float at full scale is clamped to the largest sample
    const out = new Int16Array(1);
    copyFlacSamples("f32", Float32Array.from([1]), 1, out, 0, 1, undefined, 16);
    expect(out[0]).toBe(32767);
  });

  test("rejects samples of an audio format that is not WebCodecs'", () => {
    expect(() =>
      copyFlacSamples(
        "s24",
        Int32Array.of(0),
        1,
        new Int32Array(1),
        0,
        1,
        undefined,
        24,
      ),
    ).toThrow("an audio decoder gives s24 samples");
  });

  test("rejects integer samples narrower than the stream's", () => {
    expect(() =>
      copyFlacSamples(
        "s16",
        Int16Array.of(0),
        1,
        new Int32Array(1),
        0,
        1,
        undefined,
        24,
      ),
    ).toThrow("the flac decoder gives s16 samples of a stream of 24 bits");
  });
});
