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

import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  getXyzTileUrl,
  XyzTileSourceParameters,
} from "#src/datasource/xyz/base.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

/**
 * Decodes an image (any format supported by the browser) to planar RGBA data of size
 * `tileSize * tileSize * 4`, resampling if the image size differs from `tileSize`.
 */
async function decodeImageToRgba(
  data: ArrayBuffer,
  contentType: string | undefined,
  tileSize: number,
): Promise<Uint8Array> {
  const blob = new Blob([data], contentType ? { type: contentType } : {});
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const canvas = new OffscreenCanvas(tileSize, tileSize);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0, tileSize, tileSize);
    const rgba = context.getImageData(0, 0, tileSize, tileSize).data;
    const n = tileSize * tileSize;
    const result = new Uint8Array(n * 4);
    for (let i = 0; i < n; ++i) {
      result[i] = rgba[4 * i];
      result[i + n] = rgba[4 * i + 1];
      result[i + 2 * n] = rgba[4 * i + 2];
      result[i + 3 * n] = rgba[4 * i + 3];
    }
    return result;
  } finally {
    bitmap.close();
  }
}

@registerSharedObject()
export class XyzTileSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  XyzTileSourceParameters,
) {
  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { parameters } = this;
    const [x, y] = chunk.chunkGridPosition;
    const url = getXyzTileUrl(parameters, x, y);
    const { kvStoreContext } = this.sharedKvStoreContext;
    const { store, path } = kvStoreContext.getKvStore(url);
    const response = await store.read(path, { signal });
    if (response === undefined) {
      // Missing tile: leave the chunk empty (transparent).
      return;
    }
    const data = await response.response.arrayBuffer();
    if (data.byteLength === 0) return;
    chunk.data = await decodeImageToRgba(
      data,
      response.response.headers.get("content-type") ?? undefined,
      parameters.tileSize,
    );
  }
}
