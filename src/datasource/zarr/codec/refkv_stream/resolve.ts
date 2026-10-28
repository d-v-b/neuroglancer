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
 * video planes of an MP4 file's H.264 and HEVC tracks (refkv's
 * [spec/conventions.md, section 10](https://github.com/d-v-b/refkv/blob/main/spec/conventions.md#10-coded-streams),
 * and [spec/zarrify/mp4.md](https://github.com/d-v-b/refkv/blob/main/spec/zarrify/mp4.md)).
 * The configuration is the stream's `format` ("h264" or "hevc": audio
 * streams, "mp3", "aac" and "flac", are not displayed), its `setup` (base64
 * of the avcC or hvcC box's payload) and the `plane` the array holds ("y",
 * "u" or "v"). A chunk's shape is `[pictures, height, width]`, of `uint8`
 * for 8 bits a sample, or, for HEVC Main 10, `uint16` (values 0 to 1023).
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

export interface Configuration {
  format: "h264" | "hevc";
  setup: string;
  plane: Plane;
}

registerCodec({
  name: "refkv.stream",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    verifyObject(configuration);
    const format = verifyObjectProperty(configuration, "format", verifyString);
    if (format !== "h264" && format !== "hevc") {
      throw new Error(
        `refkv.stream: ${format} streams are not displayed, only h264 and hevc video`,
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
    const { dataType } = decodedArrayInfo;
    if (
      dataType !== DataType.UINT8 &&
      !(format === "hevc" && dataType === DataType.UINT16)
    ) {
      throw new Error(
        `refkv.stream: ${format} planes are ${format === "hevc" ? "uint8 or uint16" : "uint8"}, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    if (decodedArrayInfo.chunkShape.length !== 3) {
      throw new Error(
        `refkv.stream: a ${format} plane's chunk is [pictures, height, width], not ${JSON.stringify(decodedArrayInfo.chunkShape)}`,
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
