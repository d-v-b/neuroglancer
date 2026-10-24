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
 *
 * Browsers differ in what their decoder gives. Chrome gives the decoder's own
 * Y, U and V (I420), exactly the stream's. WebKit gives them in full range
 * for a limited-range stream, and Firefox converts them to RGB (BGRX): those
 * are converted back, by the stream's range and matrix from its SPS (H.264
 * E.1), and a warning says once that the values are not exact (a value the
 * browser rounded or clipped comes back a few levels off).
 *
 * Chunks of MP3 audio are decoded with AudioDecoder in the same way: frame
 * `k` is given the timestamp of its start, `k` frames of the stream on, and
 * the samples the decoder gives for that timestamp are copied to the chunk's
 * rows from frame `k`'s position, those of a lead-in frame dropped.
 */

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_stream/resolve.js";
import type { ChunkPlanes, StreamColor } from "#src/util/refkv_stream.js";
import {
  avcCodecString,
  copyPicture,
  isExactFormat,
  mp3Stream,
  narrowRange,
  newChunkPlanes,
  parseStreamChunk,
  SharedPlanes,
  streamColor,
} from "#src/util/refkv_stream.js";

// 64 MiB: the two planes not asked for of at least one chunk of 32 MiB of luma
const SHARED = new SharedPlanes(1 << 26);

let warned = false;

/** Says once that this browser's pictures are converted, not the decoder's. */
function warnConverted(what: string) {
  if (warned) return;
  warned = true;
  console.warn(
    `refkv.stream: this browser's VideoDecoder gives H.264 pictures as ${what}; the planes are converted back and may differ from the stream's by a few levels`,
  );
}

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
  let color: StreamColor;
  try {
    color = streamColor(avcc);
  } catch {
    color = { fullRange: false };
  }
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
            const format = frame.format ?? "";
            const range = frame.colorSpace?.fullRange;
            if (!isExactFormat(format)) {
              // RGB (Firefox): back to the stream's range, by its matrix
              warnConverted(format);
              copyPicture(format, buffer, layout, planes, position, {
                matrix: color.matrix ?? frame.colorSpace?.matrix,
                fullRange: color.fullRange,
              });
            } else {
              copyPicture(format, buffer, layout, planes, position);
              if (range === true && !color.fullRange) {
                // a limited-range stream given in full range (WebKit)
                warnConverted("full-range Y, U and V");
                narrowRange(planes, position);
              }
            }
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

/** The chunk's `[samples, channels]` samples, interleaved by channel. */
export async function decodeMp3(
  encoded: Uint8Array<ArrayBuffer>,
  samples: number,
  channels: number,
  signal: AbortSignal,
): Promise<Float32Array<ArrayBuffer>> {
  const out = new Float32Array(samples * channels);
  const { units, positions } = parseStreamChunk(encoded);
  if (units.length === 0) return out;
  if (typeof AudioDecoder === "undefined") {
    throw new Error("refkv.stream: this browser has no WebCodecs AudioDecoder");
  }
  const stream = mp3Stream(units[0]);
  if (stream.channels !== channels) {
    throw new Error(
      `refkv.stream: the mp3 stream has ${stream.channels} channels, not the chunk's ${channels}`,
    );
  }
  // a frame's duration, in the microseconds of a timestamp
  const frameTime = (stream.samplesPerFrame * 1e6) / stream.sampleRate;
  const plane = new Float32Array(stream.samplesPerFrame);
  let failure: unknown;
  const decoder = new AudioDecoder({
    output(data) {
      try {
        const position = positions[Math.round(data.timestamp / frameTime)];
        if (position === undefined || position < 0 || failure !== undefined) {
          return;
        }
        const n = data.numberOfFrames;
        if (position + n > samples) {
          throw new Error(
            `refkv.stream: an mp3 frame's ${n} samples at ${position} do not fit the chunk's ${samples}`,
          );
        }
        const buffer = n > plane.length ? new Float32Array(n) : plane;
        for (let c = 0; c < channels; ++c) {
          data.copyTo(buffer, { planeIndex: c, format: "f32-planar" });
          for (let i = 0; i < n; ++i) {
            out[(position + i) * channels + c] = buffer[i];
          }
        }
      } catch (e) {
        failure ??= e;
      } finally {
        data.close();
      }
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
      codec: "mp3",
      sampleRate: stream.sampleRate,
      numberOfChannels: channels,
    });
    units.forEach((data, k) => {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Math.round(k * frameTime),
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
  if (failure !== undefined) throw failure;
  return out;
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
    if (configuration.format === "mp3") {
      const [samples, channels] = decodedArrayInfo.chunkShape;
      return decodeMp3(encoded, samples, channels, signal);
    }
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
