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
 * @file Key-value store over a phkv store (standalone profile, format version
 * 0): a file whose keys a perfect hash finds in one hop, and whose values are
 * bytes or references to byte ranges of other objects. See the phkv
 * specification, spec/bindings/phkv.md (a draft). References resolve exactly
 * as a vzip archive's do (the refkv specification's Part 1).
 */

import { makeSimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import type {
  DriverListOptions,
  FileHandle,
  ListEntry,
  ListResponse,
} from "#src/kvstore/index.js";
import { readFileHandle } from "#src/kvstore/index.js";
import type { PhkvMetadata } from "#src/kvstore/phkv/metadata.js";
import {
  MAX_PAYLOAD,
  parsePage,
  readPhkvMetadata,
  readRecord,
  SLOT_SIZE,
  utf8,
} from "#src/kvstore/phkv/metadata.js";
import { hash, slot } from "#src/kvstore/phkv/ptrhash.js";
import { ReferenceKvStore } from "#src/kvstore/vzip/backend.js";
import type { VzipEntry } from "#src/kvstore/vzip/metadata.js";
import { pagesForPrefix, VzipError } from "#src/kvstore/vzip/metadata.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { defaultStringCompare } from "#src/util/string.js";

function makeReader(base: FileHandle) {
  return async (
    offset: number,
    length: number,
    options: Partial<ProgressOptions>,
  ) => {
    const response = await readFileHandle(base, {
      throwIfMissing: true,
      byteRange: { offset, length },
      strictByteRange: true,
      signal: options.signal,
      progressListener: options.progressListener,
    });
    return new Uint8Array(await response.response.arrayBuffer());
  };
}

function getMetadataCache(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
  base: FileHandle,
) {
  const url = base.getUrl();
  return makeSimpleAsyncCache(
    sharedKvStoreContext.chunkManager,
    `phkvMetadata:${url}`,
    {
      get: async (_unused: undefined, progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Opening phkv store ${url}`,
        });
        const stat = await base.stat(progressOptions);
        if (stat?.totalSize === undefined) {
          throw new VzipError(
            "archive",
            `failed to determine the size of ${url}`,
            "phkv",
          );
        }
        const data = await readPhkvMetadata(
          makeReader(base),
          stat.totalSize,
          progressOptions,
        );
        return { data, size: data.sizeEstimate };
      },
    },
  );
}

// Shared by every store on the same file (Neuroglancer opens one per array),
// and released with the cached metadata.
const entryCache = new WeakMap<
  PhkvMetadata,
  Map<string, Promise<VzipEntry | undefined>>
>();
const pageCache = new WeakMap<
  PhkvMetadata,
  Map<number, Promise<{ key: string; entry: VzipEntry }[]>>
>();

export class PhkvKvStore extends ReferenceKvStore<PhkvMetadata> {
  protected readonly scheme = "phkv";
  protected readonly maxPayload = MAX_PAYLOAD;

  /** A phkv store reserves no names (spec §16). */
  protected isHidden() {
    return false;
  }

  protected isFormatKey() {
    return false;
  }

  private metadata: PhkvMetadata | undefined;

  protected async getMetadata(options: Partial<ProgressOptions>) {
    let { metadata } = this;
    if (metadata === undefined) {
      const cache = getMetadataCache(this.sharedKvStoreContext, this.base);
      try {
        metadata = this.metadata = await cache.get(undefined, options);
      } finally {
        cache.dispose();
      }
    }
    return metadata;
  }

  /** Looks up a key through the perfect hash (spec §19.5). */
  protected async lookup(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<VzipEntry | undefined> {
    const metadata = await this.getMetadata(options);
    const { params } = metadata;
    const want = utf8(key);
    if (params === undefined || want.length === 0) return undefined;
    let cache = entryCache.get(metadata);
    if (cache === undefined) {
      cache = new Map();
      entryCache.set(metadata, cache);
    }
    let entry = cache.get(key);
    if (entry === undefined) {
      const reader = makeReader(this.base);
      entry = (async () => {
        const s = slot(params, metadata.pilots, hash(want, params.seed));
        const bytes = await reader(
          metadata.slotsOffset + s * SLOT_SIZE,
          SLOT_SIZE,
          options,
        );
        const view = new DataView(bytes.buffer, bytes.byteOffset, SLOT_SIZE);
        const length = view.getUint32(8, true);
        if (length === 0) return undefined;
        const offset = view.getBigUint64(0, true);
        if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw this.error(
            "entry",
            `${JSON.stringify(key)}: its slot is outside RECORDS`,
          );
        }
        return readRecord(
          reader,
          metadata,
          Number(offset),
          length,
          key,
          options,
        );
      })();
      cache.set(key, entry);
      // A failure is not cached: a retry reads again.
      entry.catch(() => cache.delete(key));
    }
    return entry;
  }

  private loadPage(
    metadata: PhkvMetadata,
    index: number,
    options: Partial<ProgressOptions>,
  ) {
    let loaded = pageCache.get(metadata);
    if (loaded === undefined) {
      loaded = new Map();
      pageCache.set(metadata, loaded);
    }
    let page = loaded.get(index);
    if (page === undefined) {
      const info = metadata.pages[index];
      page = (async () => {
        const bytes = await makeReader(this.base)(
          info.offset,
          info.length,
          options,
        );
        return parsePage(bytes, info, index);
      })();
      loaded.set(index, page);
      page.catch(() => loaded.delete(index));
    }
    return page;
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const metadata = await this.getMetadata(options);
    const firstKeys = metadata.pages.map((p) => p.firstKey);
    const indices = pagesForPrefix(firstKeys, utf8(prefix));
    const pages = await Promise.all(
      indices.map((i) => this.loadPage(metadata, i, options)),
    );
    const keys: string[] = [];
    for (const page of pages) {
      for (const { key, entry } of page) {
        if (key.startsWith(prefix) && !entry.hidden) keys.push(key);
      }
    }
    keys.sort(defaultStringCompare);
    const entries: ListEntry[] = [];
    const directories = new Set<string>();
    for (const name of keys) {
      const i = name.indexOf("/", prefix.length);
      if (i === -1) entries.push({ key: name });
      else directories.add(name.substring(0, i));
    }
    return { entries, directories: Array.from(directories) };
  }
}
