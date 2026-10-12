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

import { decodeJpeg } from "#src/async_computation/decode_jpeg_request.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { WithParameters } from "#src/chunk_manager/backend.js";
import { GeoTiffTileSourceParameters } from "#src/datasource/geotiff/base.js";
import type { ImageDecoders } from "#src/datasource/geotiff/decode.js";
import {
  copyTileToChunk,
  decodeSamples,
  decompressTile,
  makeChunkData,
} from "#src/datasource/geotiff/decode.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import {
  computeChunkBounds,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

async function decodeWebp(
  data: Uint8Array<ArrayBuffer>,
  numComponents: number,
) {
  const bitmap = await createImageBitmap(
    new Blob([data], { type: "image/webp" }),
    {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    },
  );
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    const n = width * height;
    const result = new Uint8Array(n * numComponents);
    for (let c = 0; c < numComponents; ++c) {
      for (let i = 0; i < n; ++i) {
        result[c * n + i] = rgba[4 * i + Math.min(c, 3)];
      }
    }
    return result;
  } finally {
    bitmap.close();
  }
}

@registerSharedObject()
export class GeoTiffTileSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  GeoTiffTileSourceParameters,
) {
  private kvStore = this.sharedKvStoreContext.kvStoreContext.getKvStore(
    this.parameters.url,
  );

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { parameters, spec } = this;
    computeChunkBounds(this, chunk);
    const chunkDataSize = chunk.chunkDataSize!;
    const [width, height] = chunkDataSize;
    const [tx, ty] = chunk.chunkGridPosition;
    const { format, samplesPerPixel, planarConfiguration, tilesAcross } =
      parameters;
    const tileIndex = ty * tilesAcross + tx;
    const planes = planarConfiguration === 2 ? samplesPerPixel : 1;
    const decoders: ImageDecoders = {
      jpeg: async (data, numComponents) =>
        (
          await requestAsyncComputation(
            decodeJpeg,
            signal,
            [data.buffer as ArrayBuffer],
            data as Uint8Array<ArrayBuffer>,
            undefined,
            undefined,
            format.tileWidth * format.tileHeight,
            numComponents,
            false,
          )
        ).uint8Array,
      zstd: (data) =>
        requestAsyncComputation(
          decodeZstd,
          signal,
          [data.buffer as ArrayBuffer],
          data as Uint8Array<ArrayBuffer>,
        ),
      webp: (data, numComponents) =>
        decodeWebp(data as Uint8Array<ArrayBuffer>, numComponents),
    };
    const output = makeChunkData(
      spec.dataType,
      width * height * samplesPerPixel,
    );
    let empty = true;
    await Promise.all(
      Array.from({ length: planes }, async (_, plane) => {
        const index = plane * parameters.tilesPerPlane + tileIndex;
        const offset = parameters.offsets[index];
        const length = parameters.byteCounts[index];
        if (!length) {
          // Sparse tile.
          return;
        }
        const { store, path } = this.kvStore;
        const response = await store.read(path, {
          signal,
          byteRange: { offset, length },
          throwIfMissing: true,
        });
        const compressed = new Uint8Array(
          await response!.response.arrayBuffer(),
        );
        const decompressed = await decompressTile(compressed, format, decoders);
        const samples = decompressed.planar
          ? decompressed.data
          : decodeSamples(decompressed.data, format);
        copyTileToChunk(
          output,
          width,
          height,
          samples,
          decompressed.planar,
          format.tileWidth,
          format.tileHeight,
          format.samplesPerTile,
          plane,
        );
        empty = false;
      }),
    );
    if (empty) return;
    await postProcessRawData(
      chunk,
      signal,
      output as ArrayBufferView<ArrayBuffer>,
    );
  }
}
