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

import { decodeHevcChunk } from "#src/async_computation/decode_hevc_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";
import { decodeHevc } from "#src/sliceview/hevc/index.js";
import type { Chroma } from "#src/util/refkv_stream.js";
import { parseStreamChunk } from "#src/util/refkv_stream.js";

registerAsyncComputation(
  decodeHevcChunk,
  async (
    setup: Uint8Array,
    encoded: Uint8Array<ArrayBuffer>,
    frames: number,
    depth: number,
    chroma: Chroma,
  ) => {
    const { units, positions } = parseStreamChunk(encoded);
    const planes = await decodeHevc(
      setup,
      units,
      positions,
      frames,
      depth,
      chroma,
    );
    return {
      value: planes,
      transfer: Object.values(planes.data).map((d) => d!.buffer),
    };
  },
);
