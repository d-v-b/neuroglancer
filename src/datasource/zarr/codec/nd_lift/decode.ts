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

import { decodeNdicLift } from "#src/async_computation/decode_ndic_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { registerCodec } from "#src/datasource/zarr/codec/decode.js";
import { ndicDataTypeName } from "#src/datasource/zarr/codec/htj2k/decode.js";
import type { CodecArrayInfo } from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import type { Configuration } from "#src/datasource/zarr/codec/nd_lift/resolve.js";
import type { TypedArray } from "#src/util/array.js";
import { makeDataTypeArrayView } from "#src/util/data_type.js";

registerCodec({
  name: "nd_lift",
  kind: CodecKind.arrayToArray,
  async decode(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
    encoded,
    signal: AbortSignal,
  ) {
    const { dataType, chunkShape } = decodedArrayInfo;
    const coefficients = encoded as TypedArray;
    const bytes = new Uint8Array(
      coefficients.buffer,
      coefficients.byteOffset,
      coefficients.byteLength,
    );
    const decoded = await requestAsyncComputation(
      decodeNdicLift,
      signal,
      [bytes.buffer],
      bytes,
      Array.from(chunkShape),
      ndicDataTypeName(dataType),
      configuration,
    );
    return makeDataTypeArrayView(
      dataType,
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
  },
});
