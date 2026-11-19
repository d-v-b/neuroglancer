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
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import {
  decodeLz4Block,
  decodeLz4h5,
} from "#src/datasource/zarr/codec/lz4h5/decode.js";
import { decodeLzf } from "#src/datasource/zarr/codec/lzf/decode.js";
import { decodeBitshuffle } from "#src/datasource/zarr/codec/refkv_h5_bitshuffle/decode.js";
import "#src/datasource/zarr/codec/resolvers.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

// The first chunk of datasets of refkv's fixtures/hdf5/hdf5_third_party.h5, as
// h5py's `read_direct_chunk` gives them: little-endian int32 from -7, 30 to a
// chunk (hdf5plugin's filters wrote them).
const INT32 = new Uint8Array(
  new Int32Array(Array.from({ length: 30 }, (_, k) => k - 7)).buffer,
);

test("decodes LZ4 chunks as HDF5 stores them", () => {
  // A block stored as it is, its stored length being the block's.
  const stored = new Uint8Array(12 + 4 + 120);
  stored.set(bytes("00000000000000780000007800000078"));
  stored.set(INT32, 16);
  expect(decodeLz4h5(stored)).toEqual(INT32);
  // Blocks of 32 bytes, shuffled: `shuffle_lz4`'s, the first stored.
  const shuffled = decodeLz4h5(
    bytes(
      "00000000000000780000002000000020f9fafbfcfdfeff000102030405060708" +
        "090a0b0c0d0e0f10111213141516ffff0000000f10ff01001f000100025000ff" +
        "ffffff0000000f4fffffff0001000360ffffffffffff0000000b2dff00010050" +
        "0000000000",
    ),
  );
  const unshuffled = new Uint8Array(120);
  for (let i = 0; i < 30; ++i) {
    for (let j = 0; j < 4; ++j) unshuffled[4 * i + j] = shuffled[j * 30 + i];
  }
  expect(unshuffled).toEqual(INT32);
  expect(decodeLz4h5(new Uint8Array(12))).toEqual(new Uint8Array(0));
});

test("decodes LZF streams as imagecodecs writes them", () => {
  // `imagecodecs.lzf_encode(bytes(range(64)) * 3, header=False)`.
  const encoded = bytes(
    "1f000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
      "1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
      "0000e0743f013e3f",
  );
  const want = new Uint8Array(192).map((_, k) => k % 64);
  expect(decodeLzf(encoded, 192)).toEqual(want);
  expect(decodeLzf(encoded)).toEqual(want);
});

test("decodes bitshuffle chunks as the filter writes them", () => {
  for (const [hex, configuration, want] of [
    // `bitshuffle_lz4`: the default block, a short block of 24 elements, and 6 left over.
    [
      "0000000000000078000020000000001dff035555556666667878787f807f7f00807f" +
        "00000300365000007f0000110000001200000013000000140000001500000016000000",
      { elementSize: 4, blockSize: 2048, lz4: true },
      INT32,
    ],
    // `bitshuffle_bare`: blocks of 16 elements, and 6 left over.
    [
      "5555666678787f807f007f007f007f007f007f007f007f007f007f007f007f00" +
        "7f007f007f007f007f007f007f007f007f007f007f007f007f007f007f007f00" +
        "5566787f80000000000000000000000000000000000000000000000000000000" +
        "110000001200000013000000140000001500000016000000",
      { elementSize: 4, blockSize: 16, lz4: false },
      INT32,
    ],
    // `bitshuffle_block`, >u2 from 0: blocks of 8 elements, 28 elements, 4 left over.
    [
      "0000000000000038000000100000000d1300010080aaccf000000000000000000d13" +
        "00010080aaccf0ff000000000000000d1300010080aaccf000ff00000000180019001a001b",
      { elementSize: 2, blockSize: 8, lz4: true },
      new Uint8Array(new Array(28).fill(0).flatMap((_, k) => [0, k])),
    ],
  ] as const) {
    expect(decodeBitshuffle(bytes(hex), configuration)).toEqual(want);
  }
});

test("resolves refkv's HDF5 chains", () => {
  const spec = parseCodecChainSpec(
    [
      { name: "bytes", configuration: { endian: "little" } },
      { name: "numcodecs.shuffle", configuration: { elementsize: 4 } },
      { name: "imagecodecs_lzf", configuration: { header: false } },
    ],
    { dataType: DataType.INT32, chunkShape: [30] },
  );
  expect(spec[CodecKind.bytesToBytes][1]).toEqual({
    kind: CodecKind.bytesToBytes,
    name: "imagecodecs_lzf",
    configuration: { decodedSize: 120 },
  });
  for (const codec of [
    { name: "imagecodecs_lz4h5" },
    {
      name: "refkv.h5_bitshuffle",
      configuration: { elementsize: 4, block_size: 2048, compression: "lz4" },
    },
    {
      name: "blosc",
      configuration: {
        cname: "lz4",
        clevel: 5,
        shuffle: "shuffle",
        typesize: 4,
        blocksize: 0,
      },
    },
  ]) {
    const chain = parseCodecChainSpec(
      [{ name: "bytes", configuration: { endian: "little" } }, codec],
      { dataType: DataType.INT32, chunkShape: [30] },
    );
    expect(chain[CodecKind.bytesToBytes][0].name).toEqual(codec.name);
  }
});

test("rejects an LZF header", () => {
  expect(() =>
    parseCodecChainSpec(
      [
        { name: "bytes" },
        { name: "imagecodecs_lzf", configuration: { header: true } },
      ],
      { dataType: DataType.UINT8, chunkShape: [4] },
    ),
  ).toThrow(/only header: false/);
});

test("rejects LZF matches before the stream", () => {
  expect(() => decodeLzf(bytes("0061200a"))).toThrow(/corrupt/);
});

test("rejects LZF streams of another length than the chunk's", () => {
  expect(() => decodeLzf(bytes("0061"), 2)).toThrow(/1 bytes, not/);
  expect(() => decodeLzf(bytes("0161"), 2)).toThrow(/corrupt/);
  expect(() => decodeLzf(bytes("02616263"), 2)).toThrow(/longer than/);
});

test("rejects a chunk that ends inside its framing", () => {
  expect(() => decodeLz4h5(new Uint8Array(11))).toThrow(/framing/);
  expect(() => decodeLz4h5(bytes("000000000000000400000004"))).toThrow(
    /framing/,
  );
  expect(() =>
    decodeLz4h5(bytes("00000000000000040000000400000009ff")),
  ).toThrow(/framing/);
});

test("rejects a decoded length no chunk can hold", () => {
  expect(() => decodeLz4h5(bytes("000000ffffffffff00000004"))).toThrow(
    /decoded bytes/,
  );
});

test("rejects an LZ4 block of another length than its block", () => {
  expect(() =>
    decodeLz4Block(bytes("30616263"), new Uint8Array(4), "test"),
  ).toThrow(/does not decode/);
  // A match reaching before the block.
  expect(() =>
    decodeLz4Block(bytes("13610200"), new Uint8Array(8), "test"),
  ).toThrow(/does not decode/);
});

test("rejects a bitshuffle block size that is not a multiple", () => {
  const lz4 = { elementSize: 2, blockSize: 8, lz4: true };
  expect(() =>
    decodeBitshuffle(bytes("000000000000001000000007"), lz4),
  ).toThrow(/multiple of 16/);
  expect(() =>
    decodeBitshuffle(new Uint8Array(16), {
      elementSize: 2,
      blockSize: 7,
      lz4: false,
    }),
  ).toThrow(/multiple of 8/);
});

test("rejects bitshuffle chunks of partial elements", () => {
  expect(() =>
    decodeBitshuffle(new Uint8Array(7), {
      elementSize: 2,
      blockSize: 8,
      lz4: false,
    }),
  ).toThrow(/whole elements/);
  expect(() =>
    decodeBitshuffle(bytes("000000000000000700000010"), {
      elementSize: 2,
      blockSize: 8,
      lz4: true,
    }),
  ).toThrow(/whole elements/);
});

test("rejects bytes after the bitshuffle blocks", () => {
  const chunk = bytes(
    "000000000000000800000008" + "00000009" + "8000000000000000" + "00" + "ff",
  );
  expect(() =>
    decodeBitshuffle(chunk, { elementSize: 1, blockSize: 8, lz4: true }),
  ).toThrow(/after the blocks/);
});
