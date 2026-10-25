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
 * @file The refkv kvstore adapter: the file (or store) its base names,
 * virtualized in the worker by refkv (src/third_party/refkv), which writes a
 * vzip archive in memory, read by the vzip kvstore. The archive's references
 * are to the base file's own URL, so its chunks are read from there.
 */

import { makeSimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { composeByteRangeRequest } from "#src/kvstore/byte_range/file_handle.js";
import type {
  DriverReadOptions,
  FileHandle,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { KvStoreFileHandle, readFileHandle } from "#src/kvstore/index.js";
import { encodePathForUrl } from "#src/kvstore/url.js";
import { VzipKvStore } from "#src/kvstore/vzip/backend.js";
import type { FileInput } from "#src/third_party/refkv/core.js";
import { virtualizeToArchive } from "#src/third_party/refkv/core.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";

function isHttp(url: string) {
  return /^https?:/i.test(url);
}

function reader(handle: FileHandle, signal: AbortSignal | undefined) {
  return async (offset: number, length: number) => {
    const response = await readFileHandle(handle, {
      throwIfMissing: true,
      byteRange: { offset, length },
      strictByteRange: true,
      signal,
    });
    return new Uint8Array(await response.response.arrayBuffer());
  };
}

/** The vzip archive refkv writes for `source`: a store when its URL ends in
 * `/` (refkv lists and reads it, over http(s) only), else a file read through
 * its kvstore. The archive has no pins: it is written from the responses just
 * read and kept in memory, so a pin would check nothing, and the vzip kvstore
 * refuses any pin of a scheme other than http(s). */
async function virtualize(
  source: KvStoreFileHandle<string>,
  options: Partial<ProgressOptions>,
): Promise<Uint8Array> {
  const url = source.getUrl();
  if (url.split(/[?#]/, 1)[0].endsWith("/")) {
    if (!isHttp(url)) {
      throw new Error(
        `refkv: a store input must be an http(s) URL, not ${url}`,
      );
    }
    // the user named this store: a private host (a local server) is allowed
    return (
      await virtualizeToArchive(url, {
        policy: { allowPrivateHosts: true },
        pins: false,
      })
    ).archive;
  }
  const stat = await source.stat({ ...options, throwIfMissing: true });
  if (stat?.totalSize === undefined) {
    throw new Error(`refkv: failed to determine the size of ${url}`);
  }
  const dir = source.key.slice(0, source.key.lastIndexOf("/") + 1);
  const input: FileInput = {
    url,
    size: stat.totalSize,
    read: reader(source, options.signal),
    // a VSI file's tile files, beside it
    open: async (key) => {
      const sibling = new KvStoreFileHandle(source.store, dir + key);
      const s = await sibling.stat({ signal: options.signal });
      if (s?.totalSize === undefined) return undefined;
      return { size: s.totalSize, read: reader(sibling, options.signal) };
    },
  };
  return (await virtualizeToArchive(input, { pins: false })).archive;
}

function getArchiveCache(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  source: KvStoreFileHandle<string>,
) {
  const url = source.getUrl();
  return makeSimpleAsyncCache(
    sharedKvStoreContext.chunkManager,
    `refkvArchive:${url}`,
    {
      get: async (_unused: undefined, progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Virtualizing ${url} with refkv`,
        });
        const data = await virtualize(source, progressOptions);
        return { data, size: data.byteLength };
      },
    },
  );
}

/** The archive refkv writes for `source`, as a file: virtualized on first use. */
export class RefkvArchive implements FileHandle {
  private archive: Uint8Array | undefined;

  constructor(
    private sharedKvStoreContext: SharedKvStoreContextCounterpart,
    public source: KvStoreFileHandle<string>,
  ) {}

  getUrl() {
    return this.source.getUrl() + "|refkv:";
  }

  private async get(options: Partial<ProgressOptions>) {
    if (this.archive === undefined) {
      const cache = getArchiveCache(this.sharedKvStoreContext, this.source);
      try {
        this.archive = await cache.get(undefined, options);
      } finally {
        cache.dispose();
      }
    }
    return this.archive;
  }

  async stat(options: StatOptions): Promise<StatResponse> {
    return { totalSize: (await this.get(options)).byteLength };
  }

  async read(options: DriverReadOptions): Promise<ReadResponse> {
    const archive = await this.get(options);
    const { outer } = composeByteRangeRequest(
      { offset: 0, length: archive.byteLength },
      options.byteRange,
    );
    return {
      response: new Response(
        archive.slice(outer.offset, outer.offset + outer.length),
      ),
      offset: outer.offset,
      length: outer.length,
      totalSize: archive.byteLength,
    };
  }
}

/** The keys of the archive refkv writes for `source`, as the vzip kvstore reads them. */
export class RefkvKvStore extends VzipKvStore {
  constructor(
    sharedKvStoreContext: SharedKvStoreContextCounterpart,
    public source: KvStoreFileHandle<string>,
  ) {
    super(sharedKvStoreContext, new RefkvArchive(sharedKvStoreContext, source));
  }

  getUrl(key: string) {
    return this.source.getUrl() + `|refkv:${encodePathForUrl(key)}`;
  }
}
