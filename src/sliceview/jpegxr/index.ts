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
 * @file JPEG XR decoding with `jpegxr.wasm`, jxrlib built with emscripten
 * (see `jpegxr_wasm.c` and `build.sh`).
 */

export interface DecodedJpegXr {
  width: number;
  height: number;
  /** Samples per pixel: 1 (gray), 3 (R, G, B) or 4 (R, G, B, A). */
  numComponents: number;
  bytesPerSample: number;
  /** IEEE floating-point samples, rather than unsigned integers. */
  isFloat: boolean;
  /** Samples interleaved by pixel, row-major, little-endian. */
  data: Uint8Array<ArrayBuffer>;
}

const HEADER = 24;
// WASI error code ENOSYS: jxrlib's file streams are never used.
const ENOSYS = 52;

const libraryEnv = {
  emscripten_notify_memory_growth: () => {},
  clock_time_get: () => ENOSYS,
  fd_write: () => ENOSYS,
  fd_read: () => ENOSYS,
  fd_close: () => ENOSYS,
  fd_seek: () => ENOSYS,
  __syscall_unlinkat: () => -ENOSYS,
  __syscall_rmdir: () => -ENOSYS,
  __syscall_readlinkat: () => -ENOSYS,
};

let modulePromise: Promise<WebAssembly.Instance> | undefined;

function getModule() {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const m = (
        await WebAssembly.instantiateStreaming(
          fetch(new URL("./jpegxr.wasm", import.meta.url)),
          { env: libraryEnv, wasi_snapshot_preview1: libraryEnv },
        )
      ).instance;
      (m.exports._initialize as () => void)();
      return m;
    })();
  }
  return modulePromise;
}

export function decodeJpegXrWith(
  instance: WebAssembly.Instance,
  buffer: Uint8Array,
): DecodedJpegXr {
  const exports = instance.exports as {
    memory: WebAssembly.Memory;
    malloc(size: number): number;
    free(ptr: number): void;
    jpegxr_decode(ptr: number, len: number): number;
  };
  const inputPtr = exports.malloc(buffer.byteLength);
  if (inputPtr === 0) throw new Error("jpegxr: out of memory");
  let resultPtr = 0;
  try {
    new Uint8Array(exports.memory.buffer).set(buffer, inputPtr);
    resultPtr = exports.jpegxr_decode(inputPtr, buffer.byteLength);
    if (resultPtr === 0) throw new Error("jpegxr: out of memory");
    // `memory.buffer` is re-read after `jpegxr_decode`: memory growth
    // detaches the previous buffer.
    const [width, height, numComponents, bytesPerSample, sampleKind, length] =
      new Uint32Array(
        exports.memory.buffer.slice(resultPtr, resultPtr + HEADER),
      );
    const body = new Uint8Array(
      exports.memory.buffer,
      resultPtr + HEADER,
      length,
    );
    if (width === 0) {
      throw new Error(`jpegxr: ${new TextDecoder().decode(body)}`);
    }
    return {
      width,
      height,
      numComponents,
      bytesPerSample,
      isFloat: sampleKind === 1,
      data: body.slice(),
    };
  } finally {
    exports.free(inputPtr);
    if (resultPtr !== 0) exports.free(resultPtr);
  }
}

export async function decompressJpegXr(
  buffer: Uint8Array,
): Promise<DecodedJpegXr> {
  return decodeJpegXrWith(await getModule(), buffer);
}
