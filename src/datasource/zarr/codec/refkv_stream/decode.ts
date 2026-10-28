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
 * @file Decodes `refkv.stream` chunks of H.264 and HEVC video with WebCodecs'
 * VideoDecoder, in the worker: the frames are fed in order, each tagged with
 * its index as its timestamp, which the decoder gives the picture it decodes
 * to; a picture is copied to its position in the chunk as the decoder gives
 * it, and a lead-in picture (position -1) is closed at once, so that a chunk
 * holds no more than its own pictures and the decoder's reference pictures.
 * The three planes are decoded together and shared (`SharedPlanes`), so that
 * reading a picture's Y, U and V decodes it once.
 *
 * Browsers differ in what their decoder gives. Chrome gives the decoder's own
 * Y, U and V (I420 or NV12), exactly the stream's. Of H.264, WebKit gives them
 * in full range for a limited-range stream, and Firefox converts them to RGB
 * (BGRX): those are converted back, by the stream's range and matrix from its
 * SPS (H.264 E.1), and a warning says once that the values are not exact (a
 * value the browser rounded or clipped comes back a few levels off).
 *
 * HEVC is shown only as the decoder gives it: 4:2:0 of the stream's bit depth
 * (I420P10 for 10 bits) in the stream's range, by its SPS (H.265 E.2), or not
 * at all. A browser's range conversion of HEVC is not invertible: measured
 * against ffmpeg's decoding of refkv's fixtures and of VideoToolbox's
 * streams, on macOS, WebKit 26 widens a limited-range stream and Chrome 148
 * narrows a full-range one, and either's chroma then differs from the
 * stream's by up to 70 levels, while each gives the stream's own range
 * exactly. WebCodecs decodes HEVC only where the platform has a decoder for it
 * (Chrome and Edge with a hardware decoder, Safari on Apple's platforms; not
 * Firefox), so the configuration is checked with
 * `VideoDecoder.isConfigSupported` first; a browser that cannot decode it, or
 * that converts its pictures (WebKit gives 10-bit pictures as 8-bit NV12, and
 * Chrome 10-bit ones in GPU memory of no format, which WebCodecs cannot copy),
 * fails with an error that says so. One difference shows in neither the
 * stream nor the picture: WebKit's chroma of x265's streams differs from the
 * stream's by up to 58 levels even in the stream's own range (its luma, and
 * VideoToolbox's streams, an iPhone's encoder, are exact).
 */

import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/refkv_stream/resolve.js";
import { DataType } from "#src/util/data_type.js";
import type {
  ChunkPlanes,
  SampleArray,
  StreamColor,
} from "#src/util/refkv_stream.js";
import {
  avcCodecString,
  copyPicture,
  hevcCodecString,
  hevcProfile,
  hevcStreamColor,
  isExactFormat,
  isRgbFormat,
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

/** Whether this browser's VideoDecoder decodes `config`, asked once a codec
 * string. */
const SUPPORTED = new Map<string, Promise<boolean>>();

async function checkSupported(
  config: VideoDecoderConfig,
  what: string,
  hevc: boolean,
) {
  let supported = SUPPORTED.get(config.codec);
  if (supported === undefined) {
    supported = VideoDecoder.isConfigSupported(config).then(
      (s) => s.supported === true,
      () => false,
    );
    SUPPORTED.set(config.codec, supported);
  }
  if (!(await supported)) {
    throw new Error(
      `refkv.stream: this browser's VideoDecoder does not decode ${what} (${config.codec})` +
        (hevc
          ? "; WebCodecs decodes HEVC only where the platform has a decoder for it, such as Chrome or Edge with a hardware decoder, or Safari"
          : ""),
    );
  }
}

/** The chunk's Y, U and V planes, `frames` pictures each of `depth` bits a
 * sample, of the `format` ("h264" or "hevc") stream whose decoder
 * configuration is `setup`. */
export async function decodeVideo(
  format: Configuration["format"],
  setup: string,
  encoded: Uint8Array<ArrayBuffer>,
  frames: number,
  depth: number,
  signal: AbortSignal,
): Promise<ChunkPlanes> {
  if (typeof VideoDecoder === "undefined") {
    throw new Error("refkv.stream: this browser has no WebCodecs VideoDecoder");
  }
  const { units, positions } = parseStreamChunk(encoded);
  const description = base64Bytes(setup);
  const hevc = format === "hevc";
  const config: VideoDecoderConfig = {
    codec: hevc ? hevcCodecString(description) : avcCodecString(description),
    description,
    optimizeForLatency: true,
  };
  await checkSupported(
    config,
    hevc ? `HEVC ${hevcProfile(description)}` : "H.264",
    hevc,
  );
  let color: StreamColor;
  try {
    color = hevc ? hevcStreamColor(description) : streamColor(description);
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
            if (frame.format === null) {
              throw new Error(
                "refkv.stream: this browser's VideoDecoder gives pictures that WebCodecs cannot copy (of format null), as Chrome's does for 10-bit HEVC on macOS",
              );
            }
            const range = frame.colorSpace?.fullRange;
            if (hevc && !isExactFormat(frame.format, depth)) {
              throw new Error(
                `refkv.stream: this browser's VideoDecoder converts ${depth}-bit HEVC pictures to ${frame.format}; HEVC is shown only as the decoder gives it`,
              );
            }
            if (
              hevc &&
              typeof range === "boolean" &&
              range !== color.fullRange
            ) {
              const name = (full: boolean) => (full ? "full" : "limited");
              throw new Error(
                `refkv.stream: this browser's VideoDecoder converts HEVC pictures from ${name(color.fullRange)} range to ${name(range)}, which changes their chroma by up to tens of levels; HEVC is shown only as the decoder gives it`,
              );
            }
            const rect = frame.visibleRect!;
            planes ??= newChunkPlanes(frames, rect.width, rect.height, depth);
            const buffer = new Uint8Array(frame.allocationSize({ rect }));
            const layout = await frame.copyTo(buffer, { rect });
            const format = frame.format;
            if (isRgbFormat(format)) {
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
    decoder.configure(config);
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
    const depth = decodedArrayInfo.dataType === DataType.UINT16 ? 10 : 8;
    const data: SampleArray = await SHARED.take(
      configuration.setup,
      encoded,
      configuration.plane,
      () =>
        decodeVideo(
          configuration.format,
          configuration.setup,
          encoded,
          frames,
          depth,
          signal,
        ),
    );
    if (data.length !== frames * height * width) {
      // no picture decoded (a chunk of zeros), or pictures of another size
      if (data.length === 0) {
        const n = frames * height * width;
        return depth > 8 ? new Uint16Array(n) : new Uint8Array(n);
      }
      throw new Error(
        `refkv.stream: the ${configuration.plane} plane decodes to ${data.length} samples, not the chunk's ${frames * height * width}`,
      );
    }
    return data;
  },
});
