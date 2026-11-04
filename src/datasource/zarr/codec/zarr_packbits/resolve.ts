/**
 * @license
 * Copyright 2023 Google Inc.
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
 * @file The zarr-extensions `packbits` array-to-bytes codec (bit packing, not
 * TIFF's run-length PackBits, which is `imagecodecs_packbits` in `../packbits`): element `i` is
 * the bits `[i k, (i + 1) k)` of the chunk, least significant bit first, `k`
 * being `last_bit - first_bit + 1`. A decoded element is those bits shifted to
 * `first_bit`. Only `uint8` and `bool` (shown as `uint8`, 0 and 1) are
 * supported: DICOM's 1-bit images and MRC's 4-bit ones are these.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import { DATA_TYPE_BYTES, DataType } from "#src/util/data_type.js";
import {
  verifyInt,
  verifyObject,
  verifyOptionalObjectProperty,
} from "#src/util/json.js";

export enum PaddingEncoding {
  NONE = 0,
  FIRST_BYTE = 1,
  LAST_BYTE = 2,
}

export interface Configuration {
  paddingEncoding: PaddingEncoding;
  // The element's lowest bit.
  firstBit: number;
  // The bits of each element.
  numBits: number;
}

function parsePadding(value: unknown): PaddingEncoding {
  switch (value) {
    case "none":
      return PaddingEncoding.NONE;
    case "first_byte":
      return PaddingEncoding.FIRST_BYTE;
    case "last_byte":
      return PaddingEncoding.LAST_BYTE;
  }
  throw new Error(`Invalid padding_encoding: ${JSON.stringify(value)}`);
}

registerCodec({
  name: "packbits",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration; encodedSize: number } {
    verifyObject(configuration);
    const { dataType, chunkShape, elementBits } = decodedArrayInfo;
    if (dataType !== DataType.UINT8) {
      throw new Error(
        `packbits supports uint8 and bool, not ${DataType[dataType].toLowerCase()}`,
      );
    }
    const width = elementBits ?? 8 * DATA_TYPE_BYTES[dataType];
    const paddingEncoding = verifyOptionalObjectProperty(
      configuration,
      "padding_encoding",
      parsePadding,
      PaddingEncoding.NONE,
    );
    const bit = (value: unknown) =>
      value === null ? undefined : verifyInt(value);
    const firstBit =
      verifyOptionalObjectProperty(configuration, "first_bit", bit) ?? 0;
    const lastBit =
      verifyOptionalObjectProperty(configuration, "last_bit", bit) ?? width - 1;
    if (firstBit < 0 || lastBit < firstBit || lastBit >= width) {
      throw new Error(
        `packbits: the bits ${firstBit} to ${lastBit} are not a range of the ` +
          `data type's ${width}`,
      );
    }
    const numBits = lastBit - firstBit + 1;
    const numElements = chunkShape.reduce((a, b) => a * b, 1);
    return {
      configuration: { paddingEncoding, firstBit, numBits },
      encodedSize:
        Math.ceil((numElements * numBits) / 8) +
        (paddingEncoding === PaddingEncoding.NONE ? 0 : 1),
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
