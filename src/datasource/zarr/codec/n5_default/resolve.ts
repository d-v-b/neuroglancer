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
 * @file The `n5_default` array-to-bytes codec of the zarr-extensions
 * registry: each chunk is one N5 default-mode block, header included (the
 * mode, the number of dimensions and the block's size along each, all
 * big-endian, in the array's dimension order), followed by the block's
 * elements encoded with the inner codecs (`configuration.codecs`, typically
 * a full-reversal `transpose`, a big-endian `bytes` and an optional
 * compressor). The block's size may differ from the chunk's (the truncated
 * edge blocks Java N5 writes): it is decoded at its own size and then
 * truncated, or padded with zeros, to the chunk's shape.
 */

import type {
  CodecArrayInfo,
  CodecArrayLayoutInfo,
  CodecChainSpec,
} from "#src/datasource/zarr/codec/index.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import {
  parseCodecChainSpec,
  registerCodec,
} from "#src/datasource/zarr/codec/resolve.js";
import { verifyObject, verifyObjectProperty } from "#src/util/json.js";

export interface Configuration {
  /** The inner codecs as written, resolved again for a block of another size. */
  codecs: unknown;
  /** The inner codecs resolved for a block of the chunk's shape. */
  inner: CodecChainSpec;
}

registerCodec({
  name: "n5_default",
  kind: CodecKind.arrayToBytes,
  resolve(
    configuration: unknown,
    decodedArrayInfo: CodecArrayInfo,
  ): { configuration: Configuration } {
    verifyObject(configuration);
    const codecs = verifyObjectProperty(configuration, "codecs", (x) => x);
    const inner = parseCodecChainSpec(codecs, decodedArrayInfo);
    if (inner.shardingInfo !== undefined) {
      throw new Error("n5_default does not support sharding inner codecs");
    }
    return { configuration: { codecs, inner } };
  },
  getDecodedArrayLayoutInfo(
    configuration: Configuration,
    decodedArrayInfo: CodecArrayInfo,
  ): CodecArrayLayoutInfo {
    return {
      physicalToLogicalDimension:
        configuration.inner.layoutInfo[0].physicalToLogicalDimension,
      readChunkShape: decodedArrayInfo.chunkShape,
    };
  },
});
