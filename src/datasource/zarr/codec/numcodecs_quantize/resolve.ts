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
 * @file The `numcodecs.quantize` array-to-array codec, as zarr-python 3 names
 * numcodecs' `Quantize` (`zarr.codecs.numcodecs.Quantize`): rounding that only
 * encoding does, so a chunk's stored values are its values. Like zarr-python's
 * codec, it reads only an `astype` that is the array's own type.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/resolve.js";
import {
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

registerCodec({
  name: "numcodecs.quantize",
  kind: CodecKind.arrayToArray,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: undefined; encodedArrayInfo: CodecArrayInfo } {
    verifyObject(configuration);
    const dtype = verifyObjectProperty(configuration, "dtype", verifyString);
    const astype = verifyOptionalObjectProperty(
      configuration,
      "astype",
      verifyString,
    );
    if (astype !== undefined && astype !== dtype) {
      throw new Error(
        `Unsupported astype ${JSON.stringify(astype)} of dtype ${JSON.stringify(dtype)}`,
      );
    }
    return { configuration: undefined, encodedArrayInfo: decodedArrayInfo };
  },
  getDecodedArrayLayoutInfo(
    _configuration: undefined,
    _decodedArrayInfo: CodecArrayInfo,
    encodedLayout: CodecArrayLayoutInfo,
  ): CodecArrayLayoutInfo {
    return encodedLayout;
  },
});
