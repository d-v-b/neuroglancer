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

import {
  decodeNdicHtj2k,
  decodeNdicHtj2kCodestream,
  decodeNdicLift,
} from "#src/async_computation/decode_ndic_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import {
  decodeHtj2kChunk,
  decodeHtj2kCodestream,
  decodeNdLiftChunk,
} from "#src/sliceview/ndic/index.js";

registerAsyncComputation(
  decodeNdicHtj2k,
  async (data: Uint8Array, shape: number[], dtype: string) => {
    const result = await decodeHtj2kChunk(data, shape, dtype);
    return { value: result, transfer: [result.buffer] };
  },
);

registerAsyncComputation(
  decodeNdicLift,
  async (
    data: Uint8Array,
    shape: number[],
    dtype: string,
    configuration: unknown,
  ) => {
    const result = await decodeNdLiftChunk(data, shape, dtype, configuration);
    return { value: result, transfer: [result.buffer] };
  },
);

registerAsyncComputation(
  decodeNdicHtj2kCodestream,
  async (data: Uint8Array, shape: number[], dtype: string) => {
    const result = await decodeHtj2kCodestream(data, shape, dtype);
    return { value: result, transfer: [result.buffer] };
  },
);
