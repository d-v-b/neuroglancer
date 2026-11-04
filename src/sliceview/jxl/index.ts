/**
 * @license
 * Copyright 2024 William Silversmith
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

import type { DecodedImage } from "#src/async_computation/decode_png_request.js";

const libraryEnv = {};

let jxlModulePromise: Promise<WebAssembly.Instance> | undefined;

async function getJxlModulePromise() {
  if (jxlModulePromise === undefined) {
    jxlModulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./jxl_decoder.wasm", import.meta.url)),
          {
            env: libraryEnv,
            wasi_snapshot_preview1: libraryEnv,
          },
        )
      ).instance;
      return m;
    })();
  }
  return jxlModulePromise;
}

// header constants
// obtained from
// // https://github.com/libjxl/libjxl/blob/8f22cb1fb98ed27ceee59887bd291ef4d277c89d/lib/jxl/decode.cc#L118-L130
const magicSpec = [
  0,
  0,
  0,
  0xc,
  "J".charCodeAt(0),
  "X".charCodeAt(0),
  "L".charCodeAt(0),
  " ".charCodeAt(0),
  0xd,
  0xa,
  0x87,
  0xa,
];

// not a full implementation of read header, just the parts we need
function checkHeader(buffer: Uint8Array) {
  function arrayEqualTrucated(a: any, b: any): boolean {
    return a.every((val: number, idx: number) => val === b[idx]);
  }

  const len = buffer.length;
  const kCodestreamMarker = 0x0a;

  if (len < 8 + 4) {
    throw new Error(`jxl: Invalid image size: ${len}`);
  }

  // JPEG XL codestream: 0xff 0x0a
  if (len >= 1 && buffer[0] === 0xff) {
    if (len < 2) {
      throw new Error(`jxl: Not enough bytes. Got: ${len}`);
    } else if (buffer[1] === kCodestreamMarker) {
      // valid codestream
      return;
    } else {
      throw new Error(`jxl: Invalid codestream.`);
    }
  }

  // JPEG XL container
  // check for header for magic sequence
  const validMagic = arrayEqualTrucated(magicSpec, buffer);
  if (!validMagic) {
    throw new Error(`jxl: didn't match magic numbers: ${buffer.slice(0, 12)}`);
  }
}

export async function decompressJxl(
  buffer: Uint8Array,
  area: number | undefined,
  numComponents: number | undefined,
  bytesPerPixel: number,
): Promise<DecodedImage> {
  const m = await getJxlModulePromise();
  checkHeader(buffer);

  area ||= 0;
  numComponents ||= 1;

  const nbytes = area * bytesPerPixel * numComponents;

  const jxlImagePtr = (m.exports.malloc as Function)(buffer.byteLength);
  const heap = new Uint8Array((m.exports.memory as WebAssembly.Memory).buffer);
  heap.set(buffer, jxlImagePtr);

  let imagePtr = null;

  try {
    const height_and_width = (m.exports.height_and_width as Function)(
      jxlImagePtr,
      buffer.byteLength,
    );

    const width = Number(height_and_width & 0x7fffffffn);
    const height = Number(height_and_width >> 31n);

    if (width <= 0 || height <= 0) {
      throw new Error(
        `jxl: Decoding failed. Width (${width}) and/or height (${height}) invalid.`,
      );
    }

    if (area !== undefined && width * height !== area) {
      throw new Error(
        `jxl: Expected width and height (${width} x ${height}, ${width * height}) to match area: ${area}.`,
      );
    }

    imagePtr = (m.exports.decode as Function)(
      jxlImagePtr,
      buffer.byteLength,
      nbytes,
    );

    if (imagePtr === 0) {
      throw new Error("jxl: Decoding failed. Null pointer returned.");
    }

    // Likewise, we reference memory.buffer instead of heap.buffer
    // because memory growth during decompress could have detached
    // the buffer.
    const image = new Uint8Array(
      (m.exports.memory as WebAssembly.Memory).buffer,
      imagePtr,
      nbytes,
    );

    // copy the array so it can be memory managed by JS
    // and we can free the emscripten buffer
    return {
      width: width || 0,
      height: height || 0,
      numComponents: numComponents || 1,
      uint8Array: image.slice(0),
    };
  } finally {
    (m.exports.free as Function)(jxlImagePtr, buffer.byteLength);
    if (imagePtr) {
      (m.exports.free as Function)(imagePtr, nbytes);
    }
  }
}

export interface DecodedJxlSamples {
  width: number;
  height: number;
  numComponents: number;
  // Samples interleaved by pixel, row-major, in native byte order.
  data: Uint8Array<ArrayBuffer>;
}

const SAMPLE_KINDS = [
  { bits: 8, isFloat: false, kind: 0, name: "uint8" },
  { bits: 16, isFloat: false, kind: 1, name: "uint16" },
  { bits: 32, isFloat: true, kind: 2, name: "float32" },
];

const INFO_FIELDS = 7;

/**
 * Decodes a JPEG XL image of one frame to samples of `bytesPerSample` bytes,
 * floating-point or not, exactly as stored: unlike `decompressJxl`, this does
 * not scale them to 8 bits. Only lossless streams are accepted, because jxl-oxide
 * renders lossy ones (XYB-encoded, or VarDCT) up to a few levels from what
 * libjxl does, so that the same chunk would read differently elsewhere.
 */
export async function decompressJxlSamples(
  buffer: Uint8Array,
  bytesPerSample: number,
  isFloat: boolean,
): Promise<DecodedJxlSamples> {
  const sampleKind = SAMPLE_KINDS.find(
    (x) => x.bits === bytesPerSample * 8 && x.isFloat === isFloat,
  );
  if (sampleKind === undefined) {
    throw new Error(
      `jxl: unsupported samples of ${bytesPerSample} bytes, ${isFloat ? "float" : "integer"}`,
    );
  }
  const { exports } = await getJxlModulePromise();
  const { malloc, free, decode_samples, memory } = exports as unknown as {
    malloc(size: number): number;
    free(ptr: number, size: number): void;
    decode_samples(
      ptr: number,
      size: number,
      kind: number,
      info: number,
    ): number;
    memory: WebAssembly.Memory;
  };
  checkHeader(buffer);
  const infoBytes = INFO_FIELDS * 4;
  const inputPtr = malloc(buffer.byteLength);
  const infoPtr = malloc(infoBytes + 4);
  // Rust's allocator aligns to the alignment `malloc` asks of it, which is 1.
  const alignedInfoPtr = (infoPtr + 3) & ~3;
  new Uint8Array(memory.buffer).set(buffer, inputPtr);
  let outputPtr = 0;
  let outputBytes = 0;
  try {
    outputPtr = decode_samples(
      inputPtr,
      buffer.byteLength,
      sampleKind.kind,
      alignedInfoPtr,
    );
    if (outputPtr === 0) throw new Error("jxl: Decoding failed.");
    // `memory.buffer` is re-read here because decoding may have grown it.
    const [
      width,
      height,
      numComponents,
      bits,
      isFloatStream,
      exact,
      keyframes,
    ] = new Uint32Array(memory.buffer, alignedInfoPtr, INFO_FIELDS);
    outputBytes = width * height * numComponents * bytesPerSample;
    if (keyframes !== 1) {
      throw new Error(`jxl: image of ${keyframes} frames, not 1`);
    }
    if (exact !== 1) {
      throw new Error(
        "jxl: lossy images are not supported, whose samples may differ from libjxl's",
      );
    }
    if (bits !== sampleKind.bits || (isFloatStream === 1) !== isFloat) {
      throw new Error(
        `jxl: image of ${bits}-bit ${isFloatStream === 1 ? "float" : "integer"} ` +
          `samples is not ${sampleKind.name}`,
      );
    }
    return {
      width,
      height,
      numComponents,
      data: new Uint8Array(memory.buffer, outputPtr, outputBytes).slice(),
    };
  } finally {
    free(inputPtr, buffer.byteLength);
    free(infoPtr, infoBytes + 4);
    if (outputPtr !== 0) free(outputPtr, outputBytes);
  }
}
