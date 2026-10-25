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
 * @file The `refkv.stream` array-to-bytes codec: a chunk is a run of coded
 * frames of a stream whose frames depend on earlier ones, as refkv writes the
 * video planes of an MP4 file's H.264 tracks (refkv's spec/conventions.md,
 * section 10, and spec/virtualize/mp4.md, section 4.1), and the samples of
 * an MP3 file (spec/virtualize/mp3.md, section 4.1). The configuration is the
 * stream's `format`, "h264" or "mp3" ("aac" streams are not decoded). For
 * "h264", it also has the stream's `setup` (base64 of the avcC box's payload)
 * and the `plane` the array holds ("y", "u" or "v"), and a chunk's shape is
 * `[pictures, height, width]`, of `uint8`. For "mp3", a chunk's shape is
 * `[samples, channels]`, of `float32`.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import type { Plane } from "#src/util/refkv_stream.js";
import { PLANES } from "#src/util/refkv_stream.js";

export type Configuration =
  | { format: "h264"; setup: string; plane: Plane }
  | { format: "mp3" };

registerCodec({
  name: "refkv.stream",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    verifyObject(configuration);
    const format = verifyObjectProperty(configuration, "format", verifyString);
    if (format === "mp3") {
      if (decodedArrayInfo.dataType !== DataType.FLOAT32) {
        throw new Error(
          `refkv.stream: mp3 samples are float32, not ${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
        );
      }
      if (decodedArrayInfo.chunkShape.length !== 2) {
        throw new Error(
          `refkv.stream: an mp3 chunk is [samples, channels], not ${JSON.stringify(decodedArrayInfo.chunkShape)}`,
        );
      }
      return { configuration: { format } };
    }
    if (format !== "h264") {
      throw new Error(
        `refkv.stream: ${format} streams are not decoded, only h264 video and mp3 audio`,
      );
    }
    const setup = verifyObjectProperty(configuration, "setup", verifyString);
    const plane = verifyOptionalObjectProperty(
      configuration,
      "plane",
      (x) => {
        if (!(PLANES as readonly string[]).includes(x)) {
          throw new Error(`expected "y", "u" or "v", not ${JSON.stringify(x)}`);
        }
        return x as Plane;
      },
      "y",
    );
    if (decodedArrayInfo.dataType !== DataType.UINT8) {
      throw new Error(
        `refkv.stream: h264 planes are uint8, not ${DataType[decodedArrayInfo.dataType].toLowerCase()}`,
      );
    }
    if (decodedArrayInfo.chunkShape.length !== 3) {
      throw new Error(
        `refkv.stream: an h264 plane's chunk is [pictures, height, width], not ${JSON.stringify(decodedArrayInfo.chunkShape)}`,
      );
    }
    return { configuration: { format, setup, plane } };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    configuration;
    return {
      physicalToLogicalDimension: Array.from(
        decodedArrayInfo.chunkShape,
        (_, i) => i,
      ),
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
