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
 * @file Decodes `refkv.stream` chunks of H.264 video with WebCodecs'
 * VideoDecoder, in the worker: the frames are fed in order, each tagged with
 * its index as its timestamp, which the decoder gives the picture it decodes
 * to; a picture is copied to its position in the chunk as the decoder gives
 * it, and a lead-in picture (position -1) is closed at once, so that a chunk
 * holds no more than its own pictures and the decoder's reference pictures.
 * The three planes are decoded together and shared (`SharedPlanes`), so that
 * reading a picture's Y, U and V decodes it once.
 */

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_stream/resolve.js";
import type { ChunkPlanes } from "#src/util/refkv_stream.js";
import {
  avcCodecString,
  copyPicture,
  newChunkPlanes,
  parseStreamChunk,
  SharedPlanes,
} from "#src/util/refkv_stream.js";

// 64 MiB: the two planes not asked for of at least one chunk of 32 MiB of luma
const SHARED = new SharedPlanes(1 << 26);

function base64Bytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; ++i) out[i] = b.charCodeAt(i);
  return out;
}

/** The chunk's Y, U and V planes, `frames` pictures each. */
export async function decodeH264(
  setup: string,
  encoded: Uint8Array<ArrayBuffer>,
  frames: number,
  signal: AbortSignal,
): Promise<ChunkPlanes> {
  if (typeof VideoDecoder === "undefined") {
    throw new Error("refkv.stream: this browser has no WebCodecs VideoDecoder");
  }
  const { units, positions } = parseStreamChunk(encoded);
  const avcc = base64Bytes(setup);
  let planes: ChunkPlanes | undefined;
  let failure: unknown;
  const copies: Promise<void>[] = [];
  const decoder = new VideoDecoder({
    output(frame) {
      const k = frame.timestamp;
      const position = positions[k];
      if (position === undefined || position < 0 || failure !== undefined) {
        frame.close();
        return;
      }
      copies.push(
        (async () => {
          try {
            const rect = frame.visibleRect!;
            planes ??= newChunkPlanes(frames, rect.width, rect.height);
            const buffer = new Uint8Array(frame.allocationSize({ rect }));
            const layout = await frame.copyTo(buffer, { rect });
            copyPicture(frame.format ?? "", buffer, layout, planes, position);
          } catch (e) {
            failure ??= e;
          } finally {
            frame.close();
          }
        })(),
      );
    },
    error(e) {
      failure ??= e;
    },
  });
  const abort = () => {
    failure ??= signal.reason;
    if (decoder.state !== "closed") decoder.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    decoder.configure({
      codec: avcCodecString(avcc),
      description: avcc,
      optimizeForLatency: true,
    });
    units.forEach((data, k) => {
      decoder.decode(
        new EncodedVideoChunk({
          type: k === 0 ? "key" : "delta",
          timestamp: k,
          data,
        }),
      );
    });
    await decoder.flush();
  } catch (e) {
    failure ??= e;
  } finally {
    signal.removeEventListener("abort", abort);
    if (decoder.state !== "closed") decoder.close();
  }
  await Promise.all(copies);
  if (failure !== undefined) throw failure;
  return planes ?? newChunkPlanes(frames, 0, 0);
}

registerCodec({
  name: "refkv.stream",
  kind: CodecKind.arrayToBytes,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    const [frames, height, width] = decodedArrayInfo.chunkShape;
    const data = await SHARED.take(
      configuration.setup,
      encoded,
      configuration.plane,
      () => decodeH264(configuration.setup, encoded, frames, signal),
    );
    if (data.length !== frames * height * width) {
      // no picture decoded (a chunk of zeros), or pictures of another size
      if (data.length === 0) return new Uint8Array(frames * height * width);
      throw new Error(
        `refkv.stream: the ${configuration.plane} plane decodes to ${data.length} bytes, not the chunk's ${frames * height * width}`,
      );
    }
    return data;
  },
});
