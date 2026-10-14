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
import type { GeoTiffBandParameters } from "#src/datasource/geotiff/base.js";
import { GeoTiffTileSourceParameters } from "#src/datasource/geotiff/base.js";
import type {
  DecodedTiffTile,
  ImageDecoders,
  SampleArray,
} from "#src/datasource/geotiff/decode.js";
import {
  decodeTiffTile,
  makeChunkData,
  readTiffChunk,
} from "#src/datasource/geotiff/decode.js";
import { getByteRangeFromResponse } from "#src/datasource/geotiff/tiff.js";
import {
  CoalescingRangeReader,
  DecodedTileCache,
} from "#src/datasource/geotiff/tile_cache.js";
import { WithSharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import {
  computeChunkBounds,
  VolumeChunkSource,
} from "#src/sliceview/volume/backend.js";
import { registerSharedObject } from "#src/worker_rpc.js";

/**
 * Maximum total size of the decoded strips cached per chunk source.
 */
const MAX_CACHED_TILE_BYTES = 64 * 1024 * 1024;

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

/**
 * Reads the tiles of one band of a chunk source.
 */
class GeoTiffBandReader {
  private rangeReader: CoalescingRangeReader;
  private tileCache: DecodedTileCache<DecodedTiffTile | undefined>;

  constructor(
    source: GeoTiffTileSource,
    public parameters: GeoTiffBandParameters,
    maxCachedBytes: number,
  ) {
    const kvStore = source.sharedKvStoreContext.kvStoreContext.getKvStore(
      parameters.url,
    );
    this.rangeReader = new CoalescingRangeReader(
      async (offset, length, signal) => {
        const { store, path } = kvStore;
        const response = await store.read(path, {
          signal,
          byteRange: { offset, length },
          throwIfMissing: true,
        });
        return getByteRangeFromResponse(response!, offset, length);
      },
    );
    this.tileCache = new DecodedTileCache<DecodedTiffTile | undefined>(
      maxCachedBytes,
      (tile) => tile?.data.byteLength ?? 0,
    );
  }

  private async downloadTile(
    index: number,
    rows: number,
    signal: AbortSignal,
  ): Promise<DecodedTiffTile | undefined> {
    const { parameters } = this;
    const { format } = parameters;
    const offset = parameters.offsets[index];
    const length = parameters.byteCounts[index];
    if (!length) {
      // Sparse tile.
      return undefined;
    }
    const decoders: ImageDecoders = {
      jpeg: async (data, numComponents, width, height) =>
        (
          await requestAsyncComputation(
            decodeJpeg,
            signal,
            [data.buffer as ArrayBuffer],
            data as Uint8Array<ArrayBuffer>,
            width,
            height,
            undefined,
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
    // Must be called synchronously, such that the reads of all tiles of a chunk are coalesced.
    const compressed = await this.rangeReader.read(offset, length, signal);
    return decodeTiffTile(compressed, format, rows, decoders);
  }

  /**
   * Reads the region of the band covered by a chunk into `output` (planar samples).  Returns
   * `false` if all tiles of the region are sparse.
   */
  read(
    output: SampleArray,
    x0: number,
    y0: number,
    width: number,
    height: number,
    signal: AbortSignal,
  ) {
    const { parameters } = this;
    const getTile = parameters.cacheTiles
      ? (index: number, rows: number) =>
          this.tileCache.get(index, signal, (sharedSignal) =>
            this.downloadTile(index, rows, sharedSignal),
          )
      : (index: number, rows: number) => this.downloadTile(index, rows, signal);
    return readTiffChunk(
      output,
      x0,
      y0,
      width,
      height,
      parameters.layout,
      getTile,
    );
  }
}

@registerSharedObject()
export class GeoTiffTileSource extends WithParameters(
  WithSharedKvStoreContextCounterpart(VolumeChunkSource),
  GeoTiffTileSourceParameters,
) {
  private bandReaders = this.parameters.bands.map(
    (band) =>
      new GeoTiffBandReader(
        this,
        band,
        MAX_CACHED_TILE_BYTES / this.parameters.bands.length,
      ),
  );

  async download(chunk: VolumeChunk, signal: AbortSignal): Promise<void> {
    const { spec } = this;
    const [x0, y0] = computeChunkBounds(this, chunk);
    const [width, height] = chunk.chunkDataSize!;
    const { bandReaders } = this;
    const pixels = width * height;
    let numSamples = 0;
    for (const reader of bandReaders) {
      numSamples += reader.parameters.layout.samplesPerPixel;
    }
    const output = makeChunkData(spec.dataType, pixels * numSamples);
    // The samples of each band form consecutive channels.
    let sampleOffset = 0;
    const results = await Promise.all(
      bandReaders.map((reader) => {
        const { samplesPerPixel } = reader.parameters.layout;
        const bandOutput = output.subarray(
          sampleOffset * pixels,
          (sampleOffset + samplesPerPixel) * pixels,
        );
        sampleOffset += samplesPerPixel;
        return reader.read(bandOutput, x0, y0, width, height, signal);
      }),
    );
    if (!results.some((nonEmpty) => nonEmpty)) return;
    await postProcessRawData(
      chunk,
      signal,
      output as ArrayBufferView<ArrayBuffer>,
    );
  }
}
