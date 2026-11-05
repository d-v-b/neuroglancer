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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, test, vi } from "vitest";
import "#src/datasource/zarr/codec/htj2k/resolve.js";
import "#src/datasource/zarr/codec/nd_lift/resolve.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import {
  decodeHtj2kChunk,
  decodeNdLiftChunk,
} from "#src/sliceview/ndic/index.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// The samples both fixtures hold, as little-endian uint16 in C order (z, y, x).
function expectedSamples(shape: number[]) {
  const [nz, ny, nx] = shape;
  const out = new Uint16Array(nz * ny * nx);
  let i = 0;
  for (let z = 0; z < nz; ++z) {
    for (let y = 0; y < ny; ++y) {
      for (let x = 0; x < nx; ++x) {
        out[i++] =
          900 +
          37 * z +
          11 * y +
          5 * x +
          ((x * y) % 13) +
          ((7 * x + 3 * y + z) % 6);
      }
    }
  }
  return out;
}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const data = await readFile(
        path.resolve(__dirname, "../../../../sliceview/ndic/ndic_zarr_bg.wasm"),
      );
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": "application/wasm" },
      });
    }),
  );
});

// Written by nd-image-codecs 0.2.5 (Python): `zarr.create_array` with
// `codec_series(["z", "y", "x"], [4, 32, 32], "uint16", "nd-lift-ht", xy_levels=3)`
// (an `nd_lift` filter followed by the `htj2k` serializer), and with only
// `Htj2k(xy_levels=3, reversible=True)` for a (2, 32, 32) array. The samples are
// those of `expectedSamples`.
const ND_LIFT_HT = {
  shape: [4, 32, 32],
  codecs: [
    {
      name: "nd_lift",
      configuration: {
        version: "0.1",
        transforms: [
          { axis: "z", dimension: 0, kind: "lift53", levels: 2, group: 0 },
        ],
      },
    },
    {
      name: "htj2k",
      configuration: {
        xy_levels: 3,
        reversible: true,
        progression: "RPCL",
        index: true,
      },
    },
  ],
  chunk: [
    "bmRodAEBAwMEAAAAIAAAACAAAACEAAAAAAAAAE4DAAC+AAAA8QAAAHkBAABMAwAA0gMAAAAAAACEAgAAtQAAAMAAAADYAAAAggIA",
    "AFYGAAAAAAAASwIAAKUAAACuAAAAyQAAAEkCAAChCAAAAAAAAFoCAACyAAAAvAAAANYAAABYAgAA/0//UQApQAAAAAAgAAAAIAAA",
    "AAAAAAAAAAAAIAAAACAAAAAAAAAAAAABiwEB/1IADAACAAEAAwQEQAH/XAANIGhwcHBwcHBoaGj/UAAIAAIAAAAG/2QAIwABbmQt",
    "aW1hZ2UtY29kZWNzIG5kaWMtY29kZXN0cmVhbf9VAAgAQAAAAsn/kAAKAAAAAALJAAH/WAAJACIzgQiDU/+TwALfZucA78lBAbxA",
    "g0aUQZkeiR622Eg5kPoA9ZchADa4AMABWwAFoQAFaEKRCg8IBUxx8AkZtwASAQMB4AAk0EAAAGukCbgASCZ6lCMz/hSUfms2AMAB",
    "dPAAXXwAF1BRWcNaBagQoWnKM6ZYfrlUEiJzl9od6iyBqvTHc15vg5Q5Bh/YkAERIQDQQH1SsHoKNExYoJERioGbW/KgZZc7JNkg",
    "AAAggAADHDo0SC16l6kD2Hh0AanSIbyaIgLUBUYKPRISGF5m5UjhRAH+VPUxrRItWrRf6iT4KdIQsQHAAvomABfTkAC+o0xeNIIJ",
    "MYEMeeZnqwvBScUzmbUKzXeLqtwILB0xSQl+RCMFOciOVdUtLKaP6ERygMwnyJe25YgMAYjPyQEqLPYAASI0T9YGNCXJ0PRjPh+p",
    "80vcem48nHN1/bPqwdki6vlkuyRzxOvZskE78p4xWw0Z7svsI5/fFz2EfyV+f2lkf4mRRIl/Jb0DpJMJFWgiDdKFIhPoZeID6hYZ",
    "gZksAtl4aciJOW8cTBoAfLqgv2PSU9J1c88NRAJTwCUMEcnZVGqCSQNuQi5YkBoWmowG0HCoAI6GCIaSsACCdMDsCLECiAIFKUDt",
    "nDhkAPVRkEFipYGSgMek17+PEUPmNgSC+4hTK/FxYIhBdIkcrleT6N4/Ba7LShrKVYrxeWKOpzSqpQq1lZoD0JgZAxAFVBvBUlCx",
    "cEGqGlAOIB33zvpSJqsBTAzxXAGABFlsEAGQBHw3jEUAkaBgDswBERT8xQtjCVxBpGHBsGnRAqgE3wYYAFyEZtBZQOLWZiQAZREA",
    "VREAVgmABCAC4HaZdRoWiIjXaZtClbtuTwSSeUkJkkjEIAA1kMVuFbtU8DUOupIqW8dLkShDlTEPl0CxePJVRtwr1k5IGzOBiQuV",
    "A//Z/0//UQApQAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABhwEB/1IADAACAAEAAwQEQAH/XAANIEhQUFBQUFBI",
    "SEj/UAAIAAIAAAAC/2QAIwABbmQtaW1hZ2UtY29kZWNzIG5kaWMtY29kZXN0cmVhbf9VAAgAQAAAAf//kAAKAAAAAAH/AAH/WAAI",
    "ABoLGIMq/5PALXAoVFMTiWQyoVBNTSSSyfQA9ZcAADG4AMAVAPDwQZxOsrYAwBaoPA/Pw/PwPACEYTwjCeEYTyqpMn4AwC9sgF9Y",
    "wC+gwA+HJ4cn7eHhw8OH9uHhw8OH9uHhw8OH9uHhw8OH9uHhw8OH9uHhw8OH9uHhw8OH9nmyTf85L/yTsk3/OS/8k7JN/zkv/JOy",
    "Tf85L/yTsk3/OS/8k7JNf5yX/knZJn/OS3+SaR031HVPuRq8A38LMNMNsLUAM90AWwtQddcNMNMNMNMNMNMNMNMNUHXXDTDTDTDT",
    "DTDTDTDTDVB11w0w0w0w0w0w0w0w0w1QddcNMNMNMNMNMNMNMNMNUHXXDTDTDTDTDTDTDTDTDVB11w0w0w0w0w0w0w0w0w1QddcN",
    "MNMNMNMNMNMNMNMNUPUBRGcjB1HVEZyMHUdURnIwdR1RGcjB1HVEZyMHUdURnIwdR1RGcjB1HVUtSysstVKyAx/gAR7gAR7I7QEe",
    "4AEe4IHcHuABHuABHsjtAR7gAR7ggdwe4AEe4AEeyO0BHuABHuCB3B7gAR7gAR7I7QEe4AEe4IHc/nhnI52vRO9YfORzteid6w+c",
    "jna9E71h85HO16J3rD5yOdr0TvWHzkc7XonesPnI52vRO9YdJZVLGpS1GZ4D/9n/T/9RAClAAAAAACAAAAAgAAAAAAAAAAAAAAAg",
    "AAAAIAAAAAAAAAAAAAGCAQH/UgAMAAIAAQADBARAAf9cAA0gICgoKCgoKCAgIP9QAAgAAgAAAAD/ZAAjAAFuZC1pbWFnZS1jb2Rl",
    "Y3MgbmRpYy1jb2Rlc3RyZWFt/1UACABAAAABxv+QAAoAAAAAAcYAAf9YAAgACgkbgwD/k8VAUuVG/L/bdgDCcDw8AGittQDC2ACf",
    "55/nn+ef53OO0Q+cdoh847RD6y2pkAHF7XF7hF9OgOTJ4cnhRT48fHh4kQ8PHx5e5MPDh4cX+fDw4eFFPjx8eHiRDw8fHl7kw8OH",
    "h9d7Ln/km/5yS8u/8k3/OSXl3/kmf85JeXf+Sb/nJLy7f5Jv+ckvLn/km/5yS8u/8k1/nJLyf3I6b6jqm30DpAoequChBqqgCqqg",
    "CmqgCqqgCqqgBqqgCqqgCmqgCqqgCqqgBqqgCqqgCmqgCqqgCqqgBqqgCqqgCmr+c5GDqIzg+cjB1EZwfORg6iM4PnIwdRGcHzkY",
    "OojOD5yMHURnB85GDqIzg+WVFVpRWlmUAwgSAEgAIAGABAASIAESAEgAIAGABAASIAESAEgAIAGABAASIAESAEgAIAGABAASIAES",
    "AEgAIAGABAASIAESAEgAIAGABAASIAESAEgAIAGABAASIAESAEgAIAGABAASIAANFHO16J3rD6KOdr0TvWH0Uc7XonesPoo52vRO",
    "9YfRRzteid6w+ijna9E71h9FHO16J3rD6laxtS2ZnQP/2f9P/1EAKUAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAA",
    "AYYBAf9SAAwAAgABAAMEBEAB/1wADSBASEhISEhIQEBA/1AACAACAAAAAf9kACMAAW5kLWltYWdlLWNvZGVjcyBuZGljLWNvZGVz",
    "dHJlYW3/VQAIAEAAAAHV/5AACgAAAAAB1QAB/1gACAAXChqDAv+TwFqAilKpKIqiKEqloiiK8gD1l+QxtwDAJwAMDABorbUAwC1w",
    "DMMMwwzDDMNAzkYJzkYJzkYJ1lSqvwDAXucBe5wF9JhaUKoFpVoKWqqlWqqlWgpaqqVaqqVaClqqpVqqpVoKWqqlWqqlWgpaqqVa",
    "qqVaClqqpVqqpVoKWqqlWqqlWgp4Zx1EZyME5x1EZyME5x1EZyME5x1EZyME5x1EZyME5x1EZyME5x1EZyME0stVGpZWMrQDX/Xh",
    "VR9e9V/1VV/1VV/1X/VVX/VVX/Vf9VVf9VVf9V/1VV/1VV/1X/VVX/VVX/Vf9VVf9VVf9V/1VV/1VV/1ecjB1EZwfORg6iM4PnIw",
    "dRGcHzkYOojOD5yMHURnB85GDqIzg+cjB1EZwellYy1UalmUA6QEIJGkBCCRpERKpESSEklKJCmRpERKpESSEklKJCmRpERKpESS",
    "EklKJCmRpERKpESSEklKJCmRpERKpESSEklKJCmRpERKpESSEklKJCmRpERKpESSEklKJCmRpERKUM46iM5GCc46iM5GCc46iM5G",
    "Cc46iM5GCc46iM5GCc46iM5GCc46iM5GCdZZJRtZTDK0A//Z",
  ].join(""),
};

const PLAIN_HTJ2K = {
  shape: [2, 32, 32],
  codecs: [
    {
      name: "htj2k",
      configuration: {
        xy_levels: 3,
        reversible: true,
        progression: "RPCL",
        index: true,
      },
    },
  ],
  chunk: [
    "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",
  ].join(""),
};

test("decodes an htj2k chunk of uint16 planes", async () => {
  const { shape, chunk } = PLAIN_HTJ2K;
  const decoded = await decodeHtj2kChunk(fromBase64(chunk), shape, "uint16");
  expect(
    new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2),
  ).toEqual(expectedSamples(shape));
});

test("resolves nd_lift followed by htj2k and decodes the series", async () => {
  const { shape, codecs, chunk } = ND_LIFT_HT;
  const spec = parseCodecChainSpec(codecs, {
    dataType: DataType.UINT16,
    chunkShape: shape,
  });
  // nd_lift widens uint16 samples to int32, which htj2k then holds.
  expect(spec.arrayInfo.map((info) => info.dataType)).toEqual([
    DataType.UINT16,
    DataType.INT32,
  ]);
  expect(spec[CodecKind.arrayToArray].map((c) => c.name)).toEqual(["nd_lift"]);
  expect(spec[CodecKind.arrayToBytes].name).toBe("htj2k");
  const coefficients = await decodeHtj2kChunk(
    fromBase64(chunk),
    shape,
    "int32",
  );
  expect(coefficients.byteLength).toBe(4 * 32 * 32 * 4);
  const decoded = await decodeNdLiftChunk(
    coefficients,
    shape,
    "uint16",
    spec[CodecKind.arrayToArray][0].configuration,
  );
  expect(
    new Uint16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2),
  ).toEqual(expectedSamples(shape));
});

test("rejects a truncated chunk", async () => {
  const chunk = fromBase64(PLAIN_HTJ2K.chunk);
  await expect(
    decodeHtj2kChunk(
      chunk.subarray(0, chunk.length >> 1),
      PLAIN_HTJ2K.shape,
      "uint16",
    ),
  ).rejects.toThrow();
});

test("rejects unsupported data types", () => {
  expect(() =>
    parseCodecChainSpec(ND_LIFT_HT.codecs, {
      dataType: DataType.FLOAT32,
      chunkShape: [4, 32, 32],
    }),
  ).toThrow(
    /nd_lift supports 8-, 16- and 32-bit integer data types, not float32/,
  );
  expect(() =>
    parseCodecChainSpec([{ name: "htj2k" }], {
      dataType: DataType.FLOAT32,
      chunkShape: [4, 32, 32],
    }),
  ).toThrow(
    /htj2k supports 8-, 16- and 32-bit integer data types, not float32/,
  );
});

test("rejects a chunk without two dimensions", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "htj2k" }], {
      dataType: DataType.UINT16,
      chunkShape: [32],
    }),
  ).toThrow(/htj2k requires a chunk of at least two dimensions/);
});

test("rejects an nd_lift configuration with an unsupported version or dimension", () => {
  const transform = {
    axis: "z",
    dimension: 0,
    kind: "lift53",
    levels: 2,
    group: 0,
  };
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "nd_lift",
          configuration: { version: "9", transforms: [transform] },
        },
        { name: "htj2k" },
      ],
      { dataType: DataType.UINT16, chunkShape: [4, 32, 32] },
    ),
  ).toThrow(/Unsupported nd_lift version/);
  expect(() =>
    parseCodecChainSpec(
      [
        {
          name: "nd_lift",
          configuration: {
            version: "0.1",
            transforms: [{ ...transform, dimension: 3 }],
          },
        },
        { name: "htj2k" },
      ],
      { dataType: DataType.UINT16, chunkShape: [4, 32, 32] },
    ),
  ).toThrow(/nd_lift dimension 3 is outside \[0, 3\)/);
});

function asUint16(b: Uint8Array) {
  return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
}

test("nd_lift saturates restored values that leave the array's range instead of failing the chunk", async () => {
  // A low-pass band of data that steps to zero undershoots below zero, and a bright one can overshoot the maximum.
  const coefficients = new Int32Array([5, -3, 70000, 9, 1, 2, 3, 4]);
  const bytes = new Uint8Array(coefficients.buffer);
  const none = { version: "0.1", transforms: [] };
  const u16 = await decodeNdLiftChunk(bytes, [2, 2, 2], "uint16", none);
  expect(asUint16(u16)).toEqual(new Uint16Array([5, 0, 65535, 9, 1, 2, 3, 4]));
  const u8 = await decodeNdLiftChunk(bytes, [2, 2, 2], "uint8", none);
  expect(u8).toEqual(new Uint8Array([5, 0, 255, 9, 1, 2, 3, 4]));
  const i16 = await decodeNdLiftChunk(bytes, [2, 2, 2], "int16", none);
  expect(new Int16Array(i16.buffer, i16.byteOffset, 8)).toEqual(
    new Int16Array([5, -3, 32767, 9, 1, 2, 3, 4]),
  );
  // Values that fit are returned unchanged.
  const fits = await decodeNdLiftChunk(
    new Uint8Array(new Int32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer),
    [2, 2, 2],
    "uint16",
    none,
  );
  expect(asUint16(fits)).toEqual(new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]));
});
