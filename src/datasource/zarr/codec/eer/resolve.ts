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
 * @file The `imagecodecs_eer` array-to-bytes codec, configuration
 * `{"shape": [h, w], "skipbits": s, "horzbits": a, "vertbits": b}`: each chunk
 * is one frame of the Electron Event Representation, as imagecodecs'
 * `eer_decode` reads it with `superres` 0, decoded to a `uint8` array of 0s and
 * 1s whose shape ends in `[h, w]`, its other dimensions 1. The parameters are
 * limited as imagecodecs limits them.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DataType } from "#src/util/data_type.js";
import {
  parseFixedLengthArray,
  verifyInt,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export interface Configuration {
  skipBits: number;
  subPixelBits: number;
}

registerCodec({
  name: "imagecodecs_eer",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    const { dataType, chunkShape } = decodedArrayInfo;
    if (dataType !== DataType.UINT8) {
      throw new Error(
        `imagecodecs_eer supports the uint8 data type, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    verifyObject(configuration);
    const shape = verifyObjectProperty(configuration, "shape", (value) =>
      parseFixedLengthArray(new Array<number>(2), value, verifyInt),
    );
    const lead = chunkShape.length - 2;
    if (
      lead < 0 ||
      chunkShape.slice(0, lead).some((n) => n !== 1) ||
      shape.some((n, i) => chunkShape[lead + i] !== n)
    ) {
      throw new Error(
        `imagecodecs_eer: an image of shape [${shape.join(", ")}] does not ` +
          `fill a chunk of shape [${chunkShape.join(", ")}]`,
      );
    }
    const skipBits = verifyObjectProperty(configuration, "skipbits", verifyInt);
    const horzBits = verifyObjectProperty(configuration, "horzbits", verifyInt);
    const vertBits = verifyObjectProperty(configuration, "vertbits", verifyInt);
    const codeBits = skipBits + horzBits + vertBits;
    if (
      skipBits < 4 ||
      horzBits < 1 ||
      horzBits > 4 ||
      vertBits < 1 ||
      vertBits > 4 ||
      codeBits < 9 ||
      codeBits > 16
    ) {
      throw new Error(
        `imagecodecs_eer: unsupported skipbits ${skipBits}, horzbits ` +
          `${horzBits} and vertbits ${vertBits}`,
      );
    }
    verifyOptionalObjectProperty(configuration, "superres", (value) => {
      if (value !== 0 && value !== false) {
        throw new Error(
          `Only a superres of 0 is supported, but received: ${JSON.stringify(value)}`,
        );
      }
    });
    return {
      configuration: { skipBits, subPixelBits: horzBits + vertBits },
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
