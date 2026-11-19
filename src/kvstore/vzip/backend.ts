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
 * @file Key-value store over a vzip archive (format version 0): a ZIP file
 * whose entries are either bytes or references to byte ranges of other
 * objects. See the vzip specification, SPEC.md, revision 8.
 */

import { buf as crc32cbuf } from "crc-32/crc32c.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import { makeSimpleAsyncCache } from "#src/chunk_manager/generic_file_source.js";
import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { composeByteRangeRequest } from "#src/kvstore/byte_range/file_handle.js";
import type {
  ByteRangeRequest,
  DriverListOptions,
  DriverReadOptions,
  FileHandle,
  KvStore,
  ListEntry,
  ListResponse,
  ReadResponse,
  StatOptions,
  StatResponse,
} from "#src/kvstore/index.js";
import { readFileHandle } from "#src/kvstore/index.js";
import { encodePathForUrl } from "#src/kvstore/url.js";
import { HttpResolutionError, readHttpRange } from "#src/kvstore/vzip/http.js";
import { MERGE_GAP, SharedReads } from "#src/kvstore/vzip/merge.js";
import type { VzipEntry, VzipMetadata } from "#src/kvstore/vzip/metadata.js";
import {
  INDEX_KEY,
  inflateEntry,
  pageForKey,
  pagesForPrefix,
  parseCentralDirectory,
  readVzipMetadata,
  RESERVED_PREFIX,
  SOURCES_KEY,
  utf8,
  VzipError,
} from "#src/kvstore/vzip/metadata.js";
import type {
  VzipRange,
  VzipReference,
  VzipSource,
} from "#src/kvstore/vzip/proto.js";
import {
  decodeReference,
  MAX_PAYLOAD,
  rangeSize,
} from "#src/kvstore/vzip/proto.js";
import { getScheme, resolveReference } from "#src/kvstore/vzip/uri.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";
import { ProgressSpan } from "#src/util/progress_listener.js";
import { defaultStringCompare } from "#src/util/string.js";

/** ZIP's method number for Zstandard, which a phkv record's codec 2 is given here. */
export const ZSTD_METHOD = 93;

/** Largest value this reader assembles in memory (spec §10). */
const MAX_REQUEST_BYTES = 1 << 30;

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
    `vzipMetadata:${url}`,
    {
      get: async (_unused: undefined, progressOptions) => {
        using _span = new ProgressSpan(progressOptions.progressListener, {
          message: `Opening vzip archive ${url}`,
        });
        const stat = await base.stat(progressOptions);
        if (stat?.totalSize === undefined) {
          throw new VzipError(
            "archive",
            `failed to determine the size of ${url}`,
          );
        }
        const data = await readVzipMetadata(
          makeReader(base),
          stat.totalSize,
          progressOptions,
        );
        return { data, size: data.sizeEstimate };
      },
    },
  );
}

/** Translates a kvstore byte range request into `[start, end)` of a value. */
function window(
  size: number,
  byteRange: ByteRangeRequest | undefined,
): { start: number; end: number } {
  const {
    outer: { offset, length },
  } = composeByteRangeRequest({ offset: 0, length: size }, byteRange);
  return { start: offset, end: offset + length };
}

function toSafeNumber(v: bigint, what: string, format = "vzip"): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VzipError(
      "request",
      `${what} is too large for this reader`,
      format,
    );
  }
  return Number(v);
}

// Shared by every store on the same archive (Neuroglancer opens one per
// array), and released with the cached metadata.
const pageCache = new WeakMap<
  VzipMetadata,
  Map<number, Promise<Map<string, VzipEntry>>>
>();
const referenceCache = new WeakMap<VzipEntry, VzipReference>();
const sharedReadsCache = new WeakMap<ArchiveMetadata, SharedReads>();

/** What every reference store's reads need of its container (a vzip archive or a phkv store). */
export interface ArchiveMetadata {
  fileSize: number;
  sources: VzipSource[];
}

/**
 * The resolution every reference store shares (the refkv specification's Part 1): the bytes of a
 * key's entry, and a reference's ranges read from its sources, merged. A binding supplies what its
 * container does differently: finding an entry (`lookup`), its metadata, which keys it hides and
 * which entries are its own format's.
 */
export abstract class ReferenceKvStore<M extends ArchiveMetadata>
  implements KvStore
{
  constructor(
    public sharedKvStoreContext: SharedKvStoreContextCounterpart,
    public base: FileHandle,
  ) {}

  /** The name of the adapter in a URL: `<archive-url>|<scheme>:<key>`. */
  protected abstract readonly scheme: string;
  /** The longest reference payload the binding allows (spec §4.4). */
  protected abstract readonly maxPayload: number;

  protected abstract getMetadata(options: Partial<ProgressOptions>): Promise<M>;

  /** Looks up a key's entry, including hidden keys. */
  protected abstract lookup(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<VzipEntry | undefined>;

  /** Whether `key` is missing in the resolved view although it has an entry. */
  protected abstract isHidden(key: string): boolean;

  /** Whether `key` is an entry of the binding's own format, which a key source may not name. */
  protected abstract isFormatKey(key: string): boolean;

  protected error(
    errorClass: ConstructorParameters<typeof VzipError>[0],
    message: string,
  ) {
    return new VzipError(errorClass, message, this.scheme);
  }

  getUrl(key: string) {
    return this.base.getUrl() + `|${this.scheme}:${encodePathForUrl(key)}`;
  }

  get supportsOffsetReads() {
    return true;
  }
  get supportsSuffixReads() {
    return true;
  }

  /** The entry for `key` in the resolved view, or undefined if missing. */
  protected async findEntry(key: string, options: Partial<ProgressOptions>) {
    if (this.isHidden(key)) return undefined;
    const entry = await this.lookup(key, options);
    if (entry?.hidden) return undefined;
    if (entry?.error !== undefined) {
      throw this.error("entry", `${JSON.stringify(key)}: ${entry.error}`);
    }
    return entry;
  }

  protected getReference(entry: VzipEntry): VzipReference {
    let reference = referenceCache.get(entry);
    if (reference === undefined) {
      try {
        reference = decodeReference(
          entry.reference!.headerId,
          entry.reference!.payload,
          this.maxPayload,
        );
      } catch (e) {
        throw this.error(
          "payload",
          `${JSON.stringify(entry.name)}: ${(e as Error).message}`,
        );
      }
      referenceCache.set(entry, reference);
    }
    return reference;
  }

  protected static valueSize(reference: VzipReference): bigint {
    let size = 0n;
    for (const range of reference) size += rangeSize(range);
    return size;
  }

  /**
   * The bytes that resolving `[start, end)` of a value holds in memory: a range
   * with a crc32c is read whole, so a small window can need far more than it
   * returns.
   */
  protected static bytesNeeded(
    reference: VzipReference,
    start: number,
    end: number,
  ): number {
    let total = 0;
    let pos = 0;
    for (const range of reference) {
      const size = Number(rangeSize(range));
      const lo = Math.max(start, pos);
      const hi = Math.min(end, pos + size);
      if (lo < hi) total += range.crc32c !== undefined ? size : hi - lo;
      pos += size;
    }
    return total;
  }

  /** The (inflated) body of a bytes entry, or a window of a STORED one. */
  protected async readBody(
    entry: VzipEntry,
    metadata: M,
    start: number,
    end: number,
    options: Partial<ProgressOptions>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const name = JSON.stringify(entry.name);
    if (entry.bodyOffset + entry.csize > metadata.fileSize) {
      throw this.error("body", `${name}: body lies outside the file`);
    }
    if (entry.method === 0) {
      if (entry.csize !== entry.size) {
        throw this.error(
          "body",
          `${name}: STORED entry with sizes ${entry.csize} != ${entry.size}`,
        );
      }
      const stored =
        entry.inline !== undefined
          ? entry.inline.subarray(start, end)
          : await makeReader(this.base)(
              entry.bodyOffset + start,
              end - start,
              options,
            );
      // A checksum covers the whole value: it is checked when the whole is read.
      if (start === 0 && end === entry.size) this.checkCrc32c(entry, stored);
      return stored;
    }
    const raw =
      entry.inline !== undefined
        ? entry.inline.slice()
        : await makeReader(this.base)(entry.bodyOffset, entry.csize, options);
    let body: Uint8Array<ArrayBuffer>;
    try {
      body =
        entry.method === ZSTD_METHOD
          ? await requestAsyncComputation(
              decodeZstd,
              options.signal,
              [raw.buffer],
              raw,
            )
          : await inflateEntry(raw, options.signal);
    } catch {
      options.signal?.throwIfAborted();
      throw this.error(
        "body",
        `${name}: body does not ${entry.method === ZSTD_METHOD ? "decode" : "inflate"} cleanly`,
      );
    }
    if (body.length !== entry.size) {
      throw this.error(
        "body",
        `${name}: decodes to ${body.length} bytes, record says ${entry.size}`,
      );
    }
    this.checkCrc32c(entry, body);
    return body.subarray(start, end);
  }

  /** Checks a value against the CRC-32C of its record, if it has one (phkv spec §19.2). */
  protected checkCrc32c(entry: VzipEntry, value: Uint8Array) {
    if (entry.crc32c === undefined) return;
    const actual = crc32cbuf(value) >>> 0;
    if (actual !== entry.crc32c) {
      throw this.error(
        "body",
        `${JSON.stringify(entry.name)}: the value's crc32c is ${actual}, the record says ${entry.crc32c}`,
      );
    }
  }

  /** The merged reads of the archive's url sources, across its stores. */
  protected getSharedReads(metadata: M) {
    let sharedReads = sharedReadsCache.get(metadata);
    if (sharedReads === undefined) {
      sharedReads = new SharedReads((source, start, end, options) =>
        this.readSource(metadata, source, start, end, options),
      );
      sharedReadsCache.set(metadata, sharedReads);
    }
    return sharedReads;
  }

  /** Bytes `[start, end)` of a source's value (spec §6, §8.3). */
  protected async readSource(
    metadata: M,
    sourceIndex: number,
    start: number,
    end: number,
    options: Partial<ProgressOptions>,
  ): Promise<Uint8Array> {
    const source = metadata.sources[sourceIndex];
    const resolution = (message: string): never => {
      throw this.error("resolution", `source ${sourceIndex}: ${message}`);
    };
    if (source.kind === "data") {
      if (end > source.data.length) {
        resolution(`data source is shorter than ${end} bytes`);
      }
      return source.data.subarray(start, end);
    }
    if (source.kind === "key") {
      const { key } = source;
      if (this.isFormatKey(key)) {
        resolution(`key source ${JSON.stringify(key)} names a format entry`);
      }
      const entry = await this.lookup(key, options).catch((e) =>
        resolution((e as Error).message),
      );
      if (entry === undefined)
        resolution(`key source ${JSON.stringify(key)} is missing`);
      if (entry!.error !== undefined) {
        resolution(`key source ${JSON.stringify(key)} has an entry error`);
      }
      if (entry!.reference !== undefined) {
        resolution(`key source ${JSON.stringify(key)} is a reference entry`);
      }
      if (end > entry!.size) {
        resolution(
          `key source ${JSON.stringify(key)} is shorter than ${end} bytes`,
        );
      }
      try {
        return await this.readBody(entry!, metadata, start, end, options);
      } catch (e) {
        options.signal?.throwIfAborted();
        return resolution((e as Error).message);
      }
    }
    // url source: resolved against the archive's own URL (spec §6).
    const baseUrl = this.base.getUrl();
    let url: string;
    try {
      url = resolveReference(baseUrl, source.url);
    } catch (e) {
      return resolution((e as Error).message);
    }
    const scheme = getScheme(url);
    if (scheme === "http" || scheme === "https") {
      try {
        // Neuroglancer allows skipping a pin whose header a cross-origin
        // response hides (refkv's reader policy rule 7): most servers that
        // allow range requests expose none of them. A pin the response lets
        // it check is still checked.
        const { data, size, sizeHidden } = await readHttpRange(
          url,
          start,
          end,
          source.pins,
          options.signal,
          /*unverifiablePins=*/ true,
        );
        if (
          source.pins.size !== undefined &&
          !sizeHidden &&
          BigInt(size ?? -1) !== source.pins.size
        ) {
          resolution(`size pin ${source.pins.size} != ${size ?? "unknown"}`);
        }
        return data;
      } catch (e) {
        if (e instanceof VzipError) throw e;
        options.signal?.throwIfAborted();
        if (e instanceof HttpResolutionError) resolution(e.message);
        throw e;
      }
    }
    // Other schemes (gs:, s3:, ...) go through neuroglancer's kvstores,
    // which cannot check pins: pins fail closed (spec §6.1).
    const { pins } = source;
    if (
      pins.size !== undefined ||
      pins.etag !== undefined ||
      pins.modifiedNotAfter !== undefined
    ) {
      resolution(`pins cannot be checked for ${scheme}: URLs`);
    }
    try {
      const handle =
        this.sharedKvStoreContext.kvStoreContext.getFileHandle(url);
      const response = await readFileHandle(handle, {
        throwIfMissing: true,
        byteRange: { offset: start, length: end - start },
        strictByteRange: true,
        signal: options.signal,
        progressListener: options.progressListener,
      });
      return new Uint8Array(await response.response.arrayBuffer());
    } catch (e) {
      options.signal?.throwIfAborted();
      return resolution(`${url}: ${(e as Error).message}`);
    }
  }

  /** Bytes `[start, end)` of a reference's value (spec §8.3). */
  protected async readReference(
    metadata: M,
    reference: VzipReference,
    start: number,
    end: number,
    options: Partial<ProgressOptions>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    // Payload errors cover every range, even ones outside the window.
    for (const range of reference) {
      if (range.data === undefined && range.source >= metadata.sources.length) {
        throw this.error(
          "payload",
          `range uses source ${range.source}; the table has ${metadata.sources.length}`,
        );
      }
    }
    type Read = { range: VzipRange; start: number; end: number };
    const pieces: (Promise<Uint8Array> | Read)[] = [];
    // The part of each piece that the window takes. A range with a crc32c is
    // read whole, and checked before that part is taken (spec §6.3
    // <https://github.com/d-v-b/refkv/blob/main/spec/refkv.md#63-resolving-a-reference>).
    const cuts: { range: VzipRange; from: number; to: number }[] = [];
    let pos = 0;
    for (const range of reference) {
      const size = toSafeNumber(rangeSize(range), "range size", this.scheme);
      const lo = Math.max(start, pos);
      const hi = Math.min(end, pos + size);
      if (lo < hi) {
        if (range.data !== undefined) {
          pieces.push(Promise.resolve(range.data.subarray(lo - pos, hi - pos)));
          cuts.push({ range, from: 0, to: hi - lo });
        } else {
          const offset = toSafeNumber(
            range.offset,
            "range offset",
            this.scheme,
          );
          const [a, b] =
            range.crc32c !== undefined ? [0, size] : [lo - pos, hi - pos];
          const read = { range, start: offset + a, end: offset + b };
          cuts.push({ range, from: lo - pos - a, to: hi - pos - a });
          pieces.push(
            metadata.sources[range.source].kind === "url"
              ? read
              : this.readSource(
                  metadata,
                  range.source,
                  read.start,
                  read.end,
                  options,
                ),
          );
        }
      }
      pos += size;
    }
    // Combine nearby reads of each url source into runs, fetch each run once,
    // with the reads of other values waiting at the same time, and slice the
    // reads back out of it.
    const reads = pieces.filter((p): p is Read => !(p instanceof Promise));
    const sorted = [...reads].sort(
      (x, y) => x.range.source - y.range.source || x.start - y.start,
    );
    type Run = { read: Read; end: number; data?: Promise<Uint8Array> };
    const runs: Run[] = [];
    const runOf = new Map<Read, Run>();
    for (const read of sorted) {
      const last = runs[runs.length - 1];
      if (
        last !== undefined &&
        last.read.range.source === read.range.source &&
        read.start - last.end <= MERGE_GAP
      ) {
        last.end = Math.max(last.end, read.end);
      } else {
        runs.push({ read, end: read.end });
      }
      runOf.set(read, runs[runs.length - 1]);
    }
    const sharedReads = this.getSharedReads(metadata);
    for (const run of runs) {
      run.data = sharedReads.read(
        run.read.range.source,
        run.read.start,
        run.end,
        options,
      );
    }
    const whole = await Promise.all(
      pieces.map(async (p) => {
        if (p instanceof Promise) return p;
        const run = runOf.get(p)!;
        const from = p.start - run.read.start;
        return (await run.data!).subarray(from, from + (p.end - p.start));
      }),
    );
    const parts = whole.map((data, i) => {
      const { range, from, to } = cuts[i];
      if (range.crc32c !== undefined) {
        const actual = crc32cbuf(data) >>> 0;
        if (actual !== range.crc32c) {
          throw this.error(
            "resolution",
            `source ${range.source}: the bytes read do not match the range's ` +
              `crc32c ${range.crc32c} (got ${actual}): the source changed ` +
              "since the archive was written",
          );
        }
      }
      return data.subarray(from, to);
    });
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  async stat(
    key: string,
    options: StatOptions,
  ): Promise<StatResponse | undefined> {
    const entry = await this.findEntry(key, options);
    if (entry === undefined) return undefined;
    if (entry.reference === undefined) return { totalSize: entry.size };
    const size = ReferenceKvStore.valueSize(this.getReference(entry));
    return { totalSize: toSafeNumber(size, "value size", this.scheme) };
  }

  async read(
    key: string,
    options: DriverReadOptions,
  ): Promise<ReadResponse | undefined> {
    const metadata = await this.getMetadata(options);
    const entry = await this.findEntry(key, options);
    if (entry === undefined) return undefined;
    let size: number;
    let data: Uint8Array<ArrayBuffer>;
    let start: number;
    let end: number;
    if (entry.reference === undefined) {
      size = entry.size;
      ({ start, end } = window(size, options.byteRange));
      data = await this.readBody(entry, metadata, start, end, options);
    } else {
      const reference = this.getReference(entry);
      size = toSafeNumber(
        ReferenceKvStore.valueSize(reference),
        "value size",
        this.scheme,
      );
      ({ start, end } = window(size, options.byteRange));
      const needed = ReferenceKvStore.bytesNeeded(reference, start, end);
      if (needed > MAX_REQUEST_BYTES) {
        throw this.error(
          "request",
          `request of ${needed} bytes exceeds the limit`,
        );
      }
      data = await this.readReference(metadata, reference, start, end, options);
    }
    return {
      response: new Response(data),
      offset: start,
      length: end - start,
      totalSize: size,
    };
  }
}

export class VzipKvStore extends ReferenceKvStore<VzipMetadata> {
  protected readonly scheme = "vzip";
  protected readonly maxPayload = MAX_PAYLOAD;

  protected isHidden(key: string) {
    return key.startsWith(RESERVED_PREFIX);
  }

  protected isFormatKey(key: string) {
    return key === SOURCES_KEY || key === INDEX_KEY;
  }

  private metadata: VzipMetadata | undefined;

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

  private loadPage(
    metadata: VzipMetadata,
    index: number,
    options: Partial<ProgressOptions>,
  ): Promise<Map<string, VzipEntry>> {
    // Pages of the central directory, loaded on demand (paged archives).
    let loaded = pageCache.get(metadata);
    if (loaded === undefined) {
      loaded = new Map();
      pageCache.set(metadata, loaded);
    }
    let page = loaded.get(index);
    if (page === undefined) {
      const { cdOffset, pages, firstKeys } = metadata.paged!;
      const { offset, length } = pages[index];
      page = (async () => {
        const bytes = await makeReader(this.base)(
          cdOffset + offset,
          length,
          options,
        );
        let parsed: VzipEntry[];
        try {
          parsed = parseCentralDirectory(bytes);
        } catch (e) {
          throw new VzipError(
            "entry",
            `page ${index} cannot be parsed: ${(e as Error).message}`,
          );
        }
        const entries = new Map<string, VzipEntry>();
        for (const entry of parsed) {
          // A record counts only if lookup would find it on this page.
          if (pageForKey(firstKeys, utf8(entry.name)) !== index) continue;
          if (!entries.has(entry.name)) entries.set(entry.name, entry);
        }
        return entries;
      })();
      loaded.set(index, page);
      page.catch(() => loaded.delete(index));
    }
    return page;
  }

  /** Looks up a key's entry (spec §7.2), including hidden keys. */
  protected async lookup(
    key: string,
    options: Partial<ProgressOptions>,
  ): Promise<VzipEntry | undefined> {
    const metadata = await this.getMetadata(options);
    const known = metadata.entries.get(key);
    if (known !== undefined || metadata.paged === undefined) return known;
    if (key === INDEX_KEY || key === SOURCES_KEY) return undefined;
    const index = pageForKey(metadata.paged.firstKeys, utf8(key));
    if (index < 0) return undefined;
    return (await this.loadPage(metadata, index, options)).get(key);
  }

  async list(
    prefix: string,
    options: DriverListOptions,
  ): Promise<ListResponse> {
    const metadata = await this.getMetadata(options);
    const keys = new Set<string>();
    const consider = (name: string) => {
      if (name.startsWith(prefix) && !name.startsWith(RESERVED_PREFIX))
        keys.add(name);
    };
    for (const name of metadata.entries.keys()) consider(name);
    if (metadata.paged !== undefined) {
      const indices = pagesForPrefix(metadata.paged.firstKeys, utf8(prefix));
      const pages = await Promise.all(
        indices.map((i) => this.loadPage(metadata, i, options)),
      );
      for (const page of pages) for (const name of page.keys()) consider(name);
    }
    const sorted = Array.from(keys).sort(defaultStringCompare);
    const entries: ListEntry[] = [];
    const directories = new Set<string>();
    for (const name of sorted) {
      const i = name.indexOf("/", prefix.length);
      if (i === -1) entries.push({ key: name });
      else directories.add(name.substring(0, i));
    }
    return { entries, directories: Array.from(directories) };
  }
}
