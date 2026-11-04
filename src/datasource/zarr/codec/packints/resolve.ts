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
 * @file The `imagecodecs_packints` array-to-bytes codec, configuration
 * `{"bitspersample": b, "runlen": n}`: TIFF's packed samples of less than a
 * byte or a whole number of bytes, as imagecodecs' `packints_decode` reads
 * them, a bitstream most significant bit first that restarts on a byte boundary
 * every `n` samples (one row). `b` is 1, for a `uint8` array of values 0 and 1,
 * or 12, for a `uint16` array.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  bitsPerSample: 1 | 12;
  runLength: number;
}

const DATA_TYPES = { 1: DataType.UINT8, 12: DataType.UINT16 };

registerCodec({
  name: "imagecodecs_packints",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedSize: number } {
    verifyObject(configuration);
    const bitsPerSample = verifyObjectProperty(
      configuration,
      "bitspersample",
      (value) => {
        if (value !== 1 && value !== 12) {
          throw new Error(
            `Only 1 and 12 are supported, but received: ${JSON.stringify(value)}`,
          );
        }
        return value as 1 | 12;
      },
    );
    const runLength = verifyObjectProperty(configuration, "runlen", (value) => {
      if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(
          `Expected positive integer but received: ${JSON.stringify(value)}`,
        );
      }
      return value as number;
    });
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DATA_TYPES[bitsPerSample]) {
      throw new Error(
        `imagecodecs_packints: ${bitsPerSample}-bit samples are ` +
          `${DataType[DATA_TYPES[bitsPerSample]].toLowerCase()}, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const numSamples = chunkShape.reduce((a, b) => a * b, 1);
    if (numSamples % runLength !== 0) {
      throw new Error(
        `imagecodecs_packints: runlen ${runLength} does not divide the ` +
          `${numSamples} samples of a chunk of shape [${chunkShape.join(", ")}]`,
      );
    }
    return {
      configuration: { bitsPerSample, runLength },
      encodedSize:
        Math.ceil((runLength * bitsPerSample) / 8) * (numSamples / runLength),
    };
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
