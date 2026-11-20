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
import "#src/datasource/zarr/codec/imagecodecs_htj2k/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { decodeHtj2kCodestream } from "#src/sliceview/ndic/index.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function asUint16(bytes: Uint8Array) {
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

// The 64 x 64 uint16 image encoded in FULL.
function image() {
  const out = new Uint16Array(64 * 64);
  for (let y = 0; y < 64; ++y) {
    for (let x = 0; x < 64; ++x) {
      out[y * 64 + x] =
        900 + 11 * y + 5 * x + ((x * y) % 13) + ((7 * x + 3 * y) % 6);
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

// Written by imagecodecs 2026.10.10 (OpenJPH 0.32): `htj2k_encode` of `image()`, reversible.
const FULL = [
  "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",
].join("");

// FULL reduced to 32 x 32 (its last resolution dropped) by rewriting SIZ, COD, QCD and the
// tile-part header and keeping the packets of the remaining resolutions, as a refkv reference
// to a prefix of a codestream does; `REDUCED_EXPECTED` is imagecodecs' decode of it.
const REDUCED = [
  "/0//UQApQAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABDwEB/1AACAACAAAACv9SAAwAAgABAAQEBEAB/1wAECCI",
  "kJCQkJCQkJCQkJCQ/2QAFwABT3BlbkpQSCBWZXIgMC4zMi4wLv+QAAoAAAAAAscAAf+TwAArAOH43vq5+yf6AoG0AMAAE8AAE0AA",
  "EgAAGe0BCHQAkCEAY1QA9wszAMAAFfAABXwAATg0AQ4LAQQc9kMdCERM1wBgGBAjIwOMQEIC3rrrOADCzB0PhbUAwAAXTwAAXVwA",
  "AXTgAIYyjmEISngpRsEID5xikA9AnMPMZ3um186UB85OprpAIHqTOzIBIiqlBsg2lUEGQmUAD/LwDvLwCvEQD/AgIQAQQAABj4Nu",
  "hZ9NmMdZ9YM0AVwhCs8ggzBcBQhYDUZIo8oAyTE1OwH8IHI2Y3fCy/JGkbSFntLQAcAAF9HwAAX1DAABfTqWnyRojMIKMEZRgWKj",
  "d0oqATBkqaAq0jzDnqgAYkhMdK+/sffEmCNIGBWBsOjJFRQXQQA1MJoMmBbDCAGjZrFKjYJKwpESgiwLapaSqyAoDcsC6XMOUojV",
  "pPCqXR4kVen42yEx/wo4DbQ/0ppStKe7+dbQHc8RITTnZ5j9Fnmsl6770yyv1YGSE5OLWU58A5EgAIgGIgYkiRo7KVm7yCPQU0zJ",
  "JIVYoAFFNCATCsu0BElKsijIUjJ0CSK1cViMiyhNSsDCYBCIBqQMJEI5oIYgUckKHQQgUVgiQFSAgwMQQACHIjYwIKEgBwgTONgo",
  "JARSS2CSAgkgNeoRKBwahFWcuDAzIczckh3sik9IqlL3HJLjSSfdV08kux1HjyMRqqHpKZJJVySXqeG/4EgDiHMEqVIANMt7tjCF",
  "BDFCQF3KCrYuisyMNUYBvNKSje/q187EOLpVJAoZOiEElUlm+b/qGgC0FAtGjtyYLE/+OQEEBMpCJRmR/CDbjWYlHivK7dNBklQQ",
  "4CCw+4uNyBwSVflwCykoqV+l0DHZ9DF0c/qfBRa8XPytvR0vV664jvZ6b13eNji1V+y7n3cbu5VQ6VFrvEaJPrAlhmfKSys+A//Z",
].join("");
const REDUCED_EXPECTED = [
  "hgOSA5sDpQOzA7wDxQPOA9cD4APvA/gDAgQKBBMEHQQoBDUEPgRIBE8EWQRjBHAEegSFBIwElQSgBKoEtgTCBJwDrAO6A8MDygPX",
  "A+MD5AP0AwAEBwQRBCAEIgQtBDsERwRMBFgEZgRmBHUEgwSJBJIEpASjBK8EvgTIBM0E3QSyA8cDzQPYA+ID6AP2A/0DDAQTBB0E",
  "KAQwBDgESAROBFwEZARqBHkEfgSOBJYEnwSpBLMEuQTKBNEE3QTlBO8EyQPcA+QD7QP3AwIECQQWBB8EKwQ0BDwERgROBF4EZgRw",
  "BHgEgwSMBJcEoASuBLYEvgTJBM8E3wTpBPIE+QQHBeID7gP6AwEEEgQWBCAEKgQ2BDsETARUBGAEZARvBHsEhQSTBJcEowSsBLgE",
  "vgTNBNUE4wTlBPEE/gQGBRUFHAX4AwgEDAQaBCMEMgQyBEUERwRWBGAEbARzBHkEiQSNBJ0EpASzBLUExgTIBNkE4QTuBPYE+wQL",
  "BREFHwUmBTcFDQQgBCYELQQ5BD4ERQRbBGMEaQR2BHwEggSPBKIEqASwBLoEvwTIBNwE5QTtBPcE/QQGBRAFIwUrBTEFPAVDBSAE",
  "LAQ4BEUETwRbBGYEZgRyBIAEigSWBKMEpQStBLkEyATQBN0E6QTnBPMEAwULBRcFJgUmBS4FPAVJBVEFYQU2BEgEVARaBGcEawR7",
  "BH8EkgSVBKMEqAS3BLwEygTWBN0E6ATsBP4EAAUTBRkFJQUpBToFPQVLBVkFXwVqBXEFTARhBGgEcwR4BIYEjQSZBKIEsAS3BMIE",
  "yQTSBOME6QT2BPoECAUQBRoFJAU0BTgFQwVMBVMFZAVsBXcFewWMBWUEcwR8BIcElASbBKQErgS6BMEEzwTYBOME6AT0BP4ECgUV",
  "BRwFKAUvBTsFRQVQBVoFZwVpBXYFgQWMBZcFoQV8BIkElAScBKgEtAS3BMcEzATZBOYE7QT6BP0ECwUVBR8FKgU2BToFSAVNBVwF",
  "ZwVuBX0FfwWMBZkFoQWrBbkFkgSmBKkEsgTBBMgEywTgBOcE7QT8BAYFCgUUBScFKgU1BUMFSQVOBWIFaAVwBX4FhwWOBZUFqQWt",
  "BbcFxAXNBaUEsQS6BMQEzwTYBOEE7QT2BAAFCwUUBR4FKAUyBTwFRwVQBVoFZQVuBXgFgwWMBZYFoQWpBbQFvwXIBdIF3gW6BMoE",
  "2AThBOgE9QQBBQIFEgUeBSUFLwU+BUAFSwVZBWUFagV2BYQFhAWTBaEFpwWwBcIFwQXNBdwF5gXrBfsF0ATlBOsE9gQABQYFFAUb",
  "BSoFMQU7BUYFTgVWBWYFbAV6BYIFiAWXBZwFrAW0Bb0FxwXRBdcF6AXvBfsFAwYNBucE+gQCBQsFFQUgBScFNAU9BUkFUgVaBWQF",
  "bAV8BYQFjgWWBaEFqgW1Bb4FzAXUBdwF5wXtBf0FBwYQBhcGJQYABQwFGAUfBTAFNAU+BUgFVAVZBWoFcgV+BYIFjQWZBaMFsQW1",
  "BcEFygXWBdwF6wXzBQEGAwYPBhwGJAYzBjoGFgUmBSoFOAVBBVAFUAVjBWUFdAV+BYoFkQWXBacFqwW7BcIF0QXTBeQF5gX3Bf8F",
  "DAYUBhkGKQYvBj0GRAZVBisFPgVEBUsFVwVcBWMFeQWBBYcFlAWaBaAFrQXABcYFzgXYBd0F5gX6BQMGCwYVBhsGJAYuBkEGSQZP",
  "BloGYQY+BUoFVgVjBW0FeQWEBYQFkAWeBagFtAXBBcMFywXXBeYF7gX7BQcGBQYRBiEGKQY1BkQGRAZMBloGZwZvBn8GVAVmBXIF",
  "eAWFBYkFmQWdBbAFswXBBcYF1QXaBegF9AX7BQYGCgYcBh4GMQY3BkMGRwZYBlsGaQZ3Bn0GiAaPBmoFfwWGBZEFlgWkBasFtwXA",
  "Bc4F1QXgBecF8AUBBgcGFAYYBiYGLgY4BkIGUgZWBmEGagZxBoIGigaVBpkGqgaDBZEFmgWlBbIFuQXCBcwF2AXfBe0F9gUBBgYG",
  "EgYcBigGMwY6BkYGTQZZBmMGbgZ4BoUGhwaUBp8Gqga1Br8GmgWnBbIFugXGBdIF1QXlBeoF9wUEBgsGGAYbBikGMwY9BkgGVAZY",
  "BmYGawZ6BoUGjAabBp0Gqga3Br8GyQbXBrAFxAXHBdAF3wXmBekF/gUFBgsGGgYkBigGMgZFBkgGUwZhBmcGbAaABoYGjgacBqUG",
  "rAazBscGywbVBuIG6wbDBc8F2AXiBe0F9gX/BQsGFAYeBikGMgY8BkYGUAZaBmUGbgZ4BoMGjAaWBqEGqga0Br8GxwbSBt0G5gbw",
  "BvwG2AXoBfYF/wUGBhMGHwYgBjAGPAZDBk0GXAZeBmkGdwaDBogGlAaiBqIGsQa/BsUGzgbgBt8G6wb6BgQHCQcZB+4FAwYJBhQG",
  "HgYkBjIGOQZIBk8GWQZkBmwGdAaEBooGmAagBqYGtQa6BsoG0gbbBuUG7wb1BgYHDQcZByEHKwcFBhgGIAYpBjMGPgZFBlIGWwZn",
  "BnAGeAaCBooGmgaiBqwGtAa/BsgG0wbcBuoG8gb6BgUHCwcbByUHLgc1B0MHHgYqBjYGPQZOBlIGXAZmBnIGdwaIBpAGnAagBqsG",
  "twbBBs8G0wbfBugG9Ab6BgkHEQcfByEHLQc6B0IHUQdYBzYGRwZMBlgGYgZwBnAGgwaHBpQGngaqBrEGuAbJBs0G2wbjBvEG8wYF",
  "BwgHFwcgBywHNAc5B0oHUAdcB2QHdQc=",
].join("");

// `htj2k_encode(image()[:32, :32], reversible=False, level=10)`, a lossy 9/7 codestream.
const LOSSY = [
  "/0//UQApQAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAABDwEB/1AACAACAAAAIP9SAAwAAgABAAUEBEAA/1wAIyJE",
  "E0PuQ+5DyjwAPAA76DQ9ND00UC9OL04hbhN5E3kAif9dACQAIkQTQ+5D7kPKPAA8ADvoND00PTRQL04vTiFuE3kTeQCJ/2QAFwAB",
  "T3BlbkpQSCBWZXIgMC4zMi4wLv+QAAoAAAAAABoAAf+TwEqjAQd0AAAAAAAA/9k=",
].join("");

test("decodes a codestream of 16-bit samples", async () => {
  const decoded = await decodeHtj2kCodestream(
    fromBase64(FULL),
    [64, 64],
    "uint16",
  );
  expect(asUint16(decoded)).toEqual(image());
});

test("decodes a codestream into a chunk with leading dimensions of 1", async () => {
  const decoded = await decodeHtj2kCodestream(
    fromBase64(FULL),
    [1, 64, 64],
    "uint16",
  );
  expect(asUint16(decoded)).toEqual(image());
});

test("decodes a codestream cut down to a lower resolution", async () => {
  const decoded = await decodeHtj2kCodestream(
    fromBase64(REDUCED),
    [1, 32, 32],
    "uint16",
  );
  expect(asUint16(decoded)).toEqual(asUint16(fromBase64(REDUCED_EXPECTED)));
});

test("rejects a codestream that does not fill the chunk", async () => {
  await expect(
    decodeHtj2kCodestream(fromBase64(FULL), [1, 32, 32], "uint16"),
  ).rejects.toThrow(
    /HTJ2K image of shape \[64, 64\] does not fill a chunk of shape \[1,32,32\]/,
  );
  await expect(
    decodeHtj2kCodestream(fromBase64(FULL), [2, 64, 64], "uint16"),
  ).rejects.toThrow(/does not fill a chunk/);
});

test("rejects data that is not a codestream", async () => {
  await expect(
    decodeHtj2kCodestream(
      new Uint8Array([1, 2, 3, 4, 5, 6]),
      [1, 2, 2],
      "uint16",
    ),
  ).rejects.toThrow(/does not start with an SOC marker/);
});

test("rejects a lossy codestream and a truncated one", async () => {
  await expect(
    decodeHtj2kCodestream(fromBase64(LOSSY), [1, 32, 32], "uint16"),
  ).rejects.toThrow();
  const chunk = fromBase64(FULL);
  await expect(
    decodeHtj2kCodestream(
      chunk.subarray(0, chunk.length >> 1),
      [1, 64, 64],
      "uint16",
    ),
  ).rejects.toThrow();
});

test("resolves for 8- and 16-bit integers and one image per chunk", () => {
  for (const dataType of [DataType.UINT8, DataType.INT16, DataType.UINT16]) {
    parseCodecChainSpec(
      [{ name: "imagecodecs_htj2k", configuration: { level: 10 } }],
      {
        dataType,
        chunkShape: [1, 64, 64],
      },
    );
  }
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_htj2k" }], {
      dataType: DataType.FLOAT32,
      chunkShape: [1, 64, 64],
    }),
  ).toThrow(
    /imagecodecs_htj2k supports 8- and 16-bit integer data types, not float32/,
  );
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_htj2k" }], {
      dataType: DataType.UINT16,
      chunkShape: [4, 64, 64],
    }),
  ).toThrow(
    /decodes one 2-D image per chunk, but the chunk shape is \[4,64,64\]/,
  );
});
