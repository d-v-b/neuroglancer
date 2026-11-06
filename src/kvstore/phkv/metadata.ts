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
 * @file The container of a phkv store, standalone profile (the phkv
 * specification, spec/bindings/phkv.md, a draft): the superblock, the section
 * directory, the sections that a reader holds in memory (the source table,
 * the perfect hash and the page index), and the records, which a reader reads
 * where it needs them.
 *
 * Not implemented: the hybrid profile (a store inside a ZIP file), a
 * superblock before the end of the file, and PROPERTY sections (skipped).
 */

import { buf as crc32cbuf } from "crc-32/crc32c.js";
import { decodeZstd } from "#src/async_computation/decode_zstd_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { Params } from "#src/kvstore/phkv/ptrhash.js";
import type { Reader, VzipEntry } from "#src/kvstore/vzip/metadata.js";
import {
  compareBytes,
  inflateEntry,
  VzipError,
} from "#src/kvstore/vzip/metadata.js";
import type { VzipSource } from "#src/kvstore/vzip/proto.js";
import { decodeSourceTable } from "#src/kvstore/vzip/proto.js";
import type { ProgressOptions } from "#src/util/progress_listener.js";

export const MAGIC = "PHKV";
export const SUPERBLOCK_SIZE = 64;
export const DIRECTORY_ENTRY_SIZE = 40;
export const SLOT_SIZE = 12;
/** A slot whose `length` is this does not give its record's length. */
export const SLOT_LENGTH_UNKNOWN = 0xffffffff;
/** The longest reference payload (spec §19.3). */
export const MAX_PAYLOAD = 1 << 24;
/** The most the reader decodes a section to, and the most sources it holds. */
const MAX_SECTION_SIZE = 1 << 30;
const MAX_SOURCES = 1 << 24;
/** The end of the file read when a store opens, which holds the sections of a typical store. */
const TAIL_GUESS = 1 << 16;
/** What a record read takes when its slot does not give its length. */
const RECORD_GUESS = 1 << 10;

export const SECTION = {
  SOURCES: 1,
  RECORDS: 2,
  PAGES: 3,
  PTRHASH: 4,
  SLOTS: 5,
  PROPERTY: 6,
  METADATA: 7,
} as const;
const SECTION_TYPES = new Set<number>(Object.values(SECTION));

const KIND_BYTES = 0;
const KIND_RANGE = 1;
const KIND_CONCAT = 2;
const REC_INLINE = 1;
const REC_CRC32C = 2;
const REC_HIDDEN = 4;
const RANGE_ID = 0x7a76;
const CONCAT_ID = 0x7a77;
/** ZIP's method numbers, which a record's codec 0, 1 and 2 are given as entries here. */
const CODEC_METHOD = [0, 8, 93] as const;

const utf8Encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

const fail = (
  errorClass: ConstructorParameters<typeof VzipError>[0],
  message: string,
): never => {
  throw new VzipError(errorClass, message, "phkv");
};

function safe(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail("archive", `${what} is too large for this reader`);
  }
  return Number(v);
}

/** A varint at `at`, and where it ends. */
function varint(
  b: Uint8Array,
  at: number,
  errorClass: "archive" | "entry" = "entry",
): [number, number] {
  let v = 0;
  let scale = 1;
  for (let i = 0; i < 10; ++i) {
    if (at >= b.length) return fail(errorClass, "a truncated varint");
    const byte = b[at++];
    v += (byte & 0x7f) * scale;
    if (v > Number.MAX_SAFE_INTEGER) {
      return fail(errorClass, "a varint too large for this reader");
    }
    if (!(byte & 0x80)) return [v, at];
    scale *= 128;
  }
  return fail(errorClass, "an overlong varint");
}

export interface PhkvPage {
  firstKey: Uint8Array;
  /** Offset of the page in the file. */
  offset: number;
  length: number;
}

export interface PhkvMetadata {
  fileSize: number;
  sources: VzipSource[];
  /** The number of keys. */
  keyCount: number;
  params: Params | undefined;
  pilots: Uint8Array;
  /** Where RECORDS and SLOTS are in the file. */
  recordsOffset: number;
  recordsLength: number;
  slotsOffset: number;
  pages: PhkvPage[];
  /** Approximate memory use, for the cache. */
  sizeEstimate: number;
}

interface DirectoryEntry {
  type: number;
  codec: number;
  flags: number;
  offset: number;
  length: number;
  size: number;
  crc: number;
}

/** Whether `suffix`, the end of a file, ends with a standalone superblock (spec §17.2). */
export function isPhkvSuffix(suffix: Uint8Array): boolean {
  if (suffix.length < SUPERBLOCK_SIZE) return false;
  const sb = suffix.subarray(suffix.length - SUPERBLOCK_SIZE);
  const view = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  return (
    new TextDecoder().decode(sb.subarray(0, 4)) === MAGIC &&
    view.getUint32(60, true) === crc32cbuf(sb.subarray(0, 60)) >>> 0 &&
    view.getBigUint64(8, true) === 0n
  );
}

/** Opens a store (spec §22.1). Every failure is an archive error. */
export async function readPhkvMetadata(
  read: Reader,
  fileSize: number,
  options: Partial<ProgressOptions>,
): Promise<PhkvMetadata> {
  try {
    return await readPhkvMetadataImpl(read, fileSize, options);
  } catch (e) {
    if (e instanceof VzipError) throw e;
    options.signal?.throwIfAborted();
    throw new VzipError("archive", (e as Error).message, "phkv");
  }
}

async function readPhkvMetadataImpl(
  read: Reader,
  fileSize: number,
  options: Partial<ProgressOptions>,
): Promise<PhkvMetadata> {
  if (fileSize < SUPERBLOCK_SIZE) return fail("archive", "not a phkv store");
  const tailStart = Math.max(0, fileSize - TAIL_GUESS);
  const tail = await read(tailStart, fileSize - tailStart, options);
  /** Bytes of the file, from the tail if it holds them. */
  const readAt = async (
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    if (offset >= tailStart) {
      return tail.subarray(offset - tailStart, offset - tailStart + length);
    }
    return read(offset, length, options);
  };

  // The superblock (spec §17.1), at distance 0 from the end.
  const sb = tail.subarray(tail.length - SUPERBLOCK_SIZE);
  const sv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  if (
    new TextDecoder().decode(sb.subarray(0, 4)) !== MAGIC ||
    sv.getUint32(60, true) !== crc32cbuf(sb.subarray(0, 60)) >>> 0
  ) {
    return fail("archive", "not a phkv store: no superblock at the end");
  }
  const version = sv.getUint16(4, true);
  const flags = sv.getUint16(6, true);
  if (version !== 0) {
    return fail("archive", `unsupported phkv version ${version}`);
  }
  if (flags & 1) {
    return fail(
      "archive",
      "a hybrid phkv store: this reader opens standalone stores only",
    );
  }
  if (flags !== 0) return fail("archive", `unsupported phkv flags ${flags}`);
  if (sv.getBigUint64(8, true) !== 0n) {
    return fail(
      "archive",
      "a phkv store followed by other data is not supported by this reader",
    );
  }
  const keyCount = safe(sv.getBigUint64(16, true), "the key count");
  const directoryOffset = safe(
    sv.getBigUint64(24, true),
    "the directory offset",
  );
  const directoryLength = safe(
    sv.getBigUint64(32, true),
    "the directory length",
  );
  const directoryCrc = sv.getUint32(56, true);

  // The section directory (spec §17.3).
  if (
    directoryLength % DIRECTORY_ENTRY_SIZE !== 0 ||
    directoryOffset + directoryLength > fileSize
  ) {
    return fail(
      "archive",
      "the section directory lies outside the file or has a partial entry",
    );
  }
  const directory = await readAt(directoryOffset, directoryLength);
  if (crc32cbuf(directory) >>> 0 !== directoryCrc) {
    return fail("archive", "the section directory does not match its crc32c");
  }
  const sections: DirectoryEntry[] = [];
  for (let at = 0; at < directory.length; at += DIRECTORY_ENTRY_SIZE) {
    const d = new DataView(
      directory.buffer,
      directory.byteOffset + at,
      DIRECTORY_ENTRY_SIZE,
    );
    if (d.getUint16(6, true) !== 0 || d.getUint32(36, true) !== 0) {
      return fail("archive", "a directory entry's reserved fields are not 0");
    }
    const entryFlags = directory[at + 5];
    if (entryFlags & ~1) {
      return fail(
        "archive",
        `a directory entry has unknown flags ${entryFlags}`,
      );
    }
    const entry: DirectoryEntry = {
      type: d.getUint32(0, true),
      codec: directory[at + 4],
      flags: entryFlags,
      offset: safe(d.getBigUint64(8, true), "a section offset"),
      length: safe(d.getBigUint64(16, true), "a section length"),
      size: safe(d.getBigUint64(24, true), "a section size"),
      crc: d.getUint32(32, true),
    };
    if (entry.offset + entry.length > fileSize) {
      return fail("archive", `section ${entry.type} lies outside the file`);
    }
    if (!SECTION_TYPES.has(entry.type)) {
      if (entry.flags & 1) {
        return fail(
          "archive",
          `unknown section ${entry.type} must be understood`,
        );
      }
      continue;
    }
    sections.push(entry);
  }
  const one = (type: number, required: boolean) => {
    const found = sections.filter((d) => d.type === type);
    if (found.length > 1) {
      return fail("archive", `more than one section of type ${type}`);
    }
    if (found.length === 0 && required) {
      return fail("archive", `no section of type ${type}`);
    }
    return found[0] as DirectoryEntry | undefined;
  };
  const hasKeys = keyCount > 0;
  const sourcesDir = one(SECTION.SOURCES, true)!;
  const recordsDir = one(SECTION.RECORDS, hasKeys);
  const pagesDir = one(SECTION.PAGES, hasKeys);
  const ptrhashDir = one(SECTION.PTRHASH, hasKeys);
  const slotsDir = one(SECTION.SLOTS, hasKeys);
  const metadataDir = one(SECTION.METADATA, false);
  if (!hasKeys && (recordsDir || pagesDir || ptrhashDir || slotsDir)) {
    return fail("archive", "a store with no keys has sections that need keys");
  }
  for (const d of [recordsDir, slotsDir]) {
    if (d !== undefined && d.codec !== 0) {
      return fail("archive", `section ${d.type} has codec ${d.codec}`);
    }
  }

  /** A section read whole: checked against its crc32c and decoded to its size (spec §17.5). */
  const whole = async (d: DirectoryEntry): Promise<Uint8Array> => {
    const stored = await readAt(d.offset, d.length);
    if (crc32cbuf(stored) >>> 0 !== d.crc) {
      return fail("archive", `section ${d.type} does not match its crc32c`);
    }
    if (d.size > MAX_SECTION_SIZE) {
      return fail(
        "archive",
        `section ${d.type} is larger than this reader allows`,
      );
    }
    let body: Uint8Array;
    if (d.codec === 0) {
      body = stored;
    } else if (d.codec === 1 || d.codec === 2) {
      const copy = stored.slice();
      try {
        body =
          d.codec === 1
            ? await inflateEntry(copy, options.signal)
            : await requestAsyncComputation(
                decodeZstd,
                options.signal,
                [copy.buffer],
                copy,
              );
      } catch (e) {
        options.signal?.throwIfAborted();
        return fail(
          "archive",
          `section ${d.type} does not decode cleanly: ${(e as Error).message}`,
        );
      }
    } else {
      return fail(
        "archive",
        `section ${d.type} has codec ${d.codec}, which the format does not define`,
      );
    }
    if (body.length !== d.size) {
      return fail(
        "archive",
        `section ${d.type} decodes to ${body.length} bytes, not ${d.size}`,
      );
    }
    return body;
  };

  let sources: VzipSource[];
  try {
    sources = decodeSourceTable(await whole(sourcesDir));
  } catch (e) {
    if (e instanceof VzipError) throw e;
    return fail("archive", `source table: ${(e as Error).message}`);
  }
  if (sources.length > MAX_SOURCES) {
    return fail(
      "archive",
      `the source table has ${sources.length} sources; this reader allows ${MAX_SOURCES}`,
    );
  }
  if (metadataDir !== undefined) await whole(metadataDir);

  const metadata: PhkvMetadata = {
    fileSize,
    sources,
    keyCount,
    params: undefined,
    pilots: new Uint8Array(0),
    recordsOffset: 0,
    recordsLength: 0,
    slotsOffset: 0,
    pages: [],
    sizeEstimate: 4096 + sources.length * 128,
  };
  if (!hasKeys) return metadata;

  // The perfect hash (spec §18.2).
  const ph = await whole(ptrhashDir!);
  if (ph.length < 40 || ph[0] !== 1 || ph.subarray(1, 8).some((b) => b !== 0)) {
    return fail("archive", "the PTRHASH section is malformed");
  }
  const pv = new DataView(ph.buffer, ph.byteOffset, ph.byteLength);
  const params: Params = {
    seed: pv.getBigUint64(8, true),
    parts: safe(pv.getBigUint64(16, true), "the part count"),
    slots: safe(pv.getBigUint64(24, true), "the slots per part"),
    buckets: safe(pv.getBigUint64(32, true), "the buckets per part"),
  };
  if (
    params.parts === 0 ||
    params.slots === 0 ||
    params.buckets === 0 ||
    params.parts * params.slots < keyCount ||
    params.parts * params.slots >= 2 ** 32 ||
    params.slots >= 2 ** 32 ||
    params.buckets >= 2 ** 32 ||
    params.parts >= 2 ** 32 ||
    ph.length !== 40 + params.parts * params.buckets
  ) {
    return fail("archive", "the PTRHASH section is malformed");
  }
  if (slotsDir!.length !== SLOT_SIZE * params.parts * params.slots) {
    return fail("archive", "the SLOTS section is not 12 bytes per slot");
  }
  metadata.params = params;
  metadata.pilots = ph.subarray(40);
  metadata.recordsOffset = recordsDir!.offset;
  metadata.recordsLength = recordsDir!.length;
  metadata.slotsOffset = slotsDir!.offset;

  // The page index: contiguous over RECORDS, with strictly increasing first
  // keys (spec §19.4).
  const pagesBytes = await whole(pagesDir!);
  let at = 0;
  let next = 0;
  let previous: Uint8Array | undefined;
  try {
    while (at < pagesBytes.length) {
      let keyLength: number;
      [keyLength, at] = varint(pagesBytes, at, "archive");
      if (keyLength === 0 || at + keyLength > pagesBytes.length) {
        throw new Error("a page with a bad first_key");
      }
      const firstKey = pagesBytes.slice(at, at + keyLength);
      strictUtf8.decode(firstKey);
      at += keyLength;
      let offset: number;
      let length: number;
      [offset, at] = varint(pagesBytes, at, "archive");
      [length, at] = varint(pagesBytes, at, "archive");
      if (length === 0 || offset !== recordsDir!.offset + next) {
        throw new Error("the pages are not contiguous over RECORDS");
      }
      if (previous !== undefined && compareBytes(previous, firstKey) >= 0) {
        throw new Error("page keys are not increasing");
      }
      previous = firstKey;
      next += length;
      metadata.pages.push({ firstKey, offset, length });
    }
    if (next !== recordsDir!.length) {
      throw new Error("the pages do not fill RECORDS");
    }
  } catch (e) {
    if (e instanceof VzipError) throw e;
    return fail("archive", `the page index: ${(e as Error).message}`);
  }
  metadata.sizeEstimate +=
    ph.length + metadata.pages.length * 64 + pagesBytes.length;
  return metadata;
}

/** A parsed record: the entry it gives, and where it ends. */
export interface ParsedRecord {
  key: Uint8Array;
  entry: VzipEntry;
  /** The end of the record, in the buffer parsed. */
  end: number;
}

/** Thrown by `parseRecord` when `body` may be a prefix of the record and ends inside it. */
export class NeedMore extends Error {
  constructor() {
    super("the record extends past the bytes read");
  }
}

/**
 * Parses the record at `at` of `body`, which starts at file offset `base`
 * (spec §19.1); the record ends at or before `limit`. A malformed record is an
 * entry error. With `partial`, `body` may end inside the record, which throws
 * `NeedMore`: the caller reads more of it and parses again.
 */
export function parseRecord(
  body: Uint8Array,
  at: number,
  limit: number,
  base: number,
  name: string,
  partial = false,
): ParsedRecord {
  const bad = (m: string): never => fail("entry", `${name}: ${m}`);
  const short = (): never => {
    if (partial) throw new NeedMore();
    return bad("a record that extends past its end");
  };
  let p = at;
  const byte = () => (p < body.length ? body[p++] : short());
  const num = () => {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 10; ++i) {
      const b = byte();
      v += (b & 0x7f) * scale;
      if (v > Number.MAX_SAFE_INTEGER)
        bad("a number too large for this reader");
      if (!(b & 0x80)) return v;
      scale *= 128;
    }
    return bad("an overlong varint");
  };
  const keyLength = num();
  const kind = byte();
  const flags = byte();
  if (
    keyLength === 0 ||
    kind > KIND_CONCAT ||
    flags & ~(REC_INLINE | REC_CRC32C | REC_HIDDEN)
  ) {
    bad("a malformed record");
  }
  num(); // rank
  const entry: VzipEntry = {
    name,
    method: 0,
    csize: 0,
    size: 0,
    bodyOffset: 0,
    hidden: (flags & REC_HIDDEN) !== 0,
  };
  let dataLength = 0;
  let offset = 0;
  if (kind === KIND_BYTES) {
    const codec = byte();
    if (codec > 2) bad("a malformed record");
    if (!(flags & REC_INLINE)) offset = num();
    entry.csize = num();
    entry.size = num();
    if (flags & REC_CRC32C) {
      if (p + 4 > body.length) short();
      entry.crc32c = new DataView(
        body.buffer,
        body.byteOffset + p,
        4,
      ).getUint32(0, true);
      p += 4;
    }
    entry.method = CODEC_METHOD[codec];
    dataLength = flags & REC_INLINE ? entry.csize : 0;
  } else {
    if (flags & (REC_INLINE | REC_CRC32C)) {
      bad("a malformed reference record");
    }
    dataLength = num();
    if (dataLength > MAX_PAYLOAD) bad("a reference payload over 2^24 bytes");
  }
  const end = p + keyLength + dataLength;
  if (end > limit) bad("a record that extends past its end");
  if (end > body.length) short();
  const keyBytes = body.slice(p, p + keyLength);
  try {
    strictUtf8.decode(keyBytes);
  } catch {
    return bad("a key that is not UTF-8");
  }
  p += keyLength;
  if (kind === KIND_BYTES) {
    if (flags & REC_INLINE) {
      entry.bodyOffset = base + p;
      entry.inline = body.slice(p, p + dataLength);
    } else {
      entry.bodyOffset = offset;
    }
  } else {
    entry.reference = {
      headerId: kind === KIND_RANGE ? RANGE_ID : CONCAT_ID,
      payload: body.slice(p, p + dataLength),
    };
  }
  return { key: keyBytes, entry, end };
}

/**
 * The record a slot points to (spec §19.5 steps 3 and 4): its entry, or
 * undefined if the record's key is not `key`.
 */
export async function readRecord(
  read: Reader,
  metadata: PhkvMetadata,
  slotOffset: number,
  slotLength: number,
  key: string,
  options: Partial<ProgressOptions>,
): Promise<VzipEntry | undefined> {
  const { recordsOffset, recordsLength } = metadata;
  const name = JSON.stringify(key);
  const known = slotLength !== SLOT_LENGTH_UNKNOWN;
  if (
    slotOffset >= recordsLength ||
    (known && (slotLength < 6 || slotOffset + slotLength > recordsLength))
  ) {
    fail("entry", `${name}: its slot is outside RECORDS`);
  }
  const available = recordsLength - slotOffset;
  let length = known ? slotLength : Math.min(RECORD_GUESS, available);
  for (;;) {
    const body = await read(recordsOffset + slotOffset, length, options);
    try {
      const parsed = parseRecord(
        body,
        0,
        known ? slotLength : available,
        recordsOffset + slotOffset,
        name,
        !known && length < available,
      );
      if (known && parsed.end !== slotLength) {
        fail("entry", `${name}: its record is not as long as its slot`);
      }
      return compareBytes(parsed.key, utf8(key)) === 0
        ? parsed.entry
        : undefined;
    } catch (e) {
      if (!(e instanceof NeedMore)) throw e;
      length = Math.min(length * 4, available);
    }
  }
}

/**
 * The records of a page (spec §19.4). A page that is not a sequence of whole
 * records that fills it, or whose first record's key is not its `first_key`,
 * cannot be parsed: an entry error.
 */
export function parsePage(
  bytes: Uint8Array,
  page: PhkvPage,
  index: number,
): { key: string; entry: VzipEntry }[] {
  const records: { key: string; entry: VzipEntry }[] = [];
  let at = 0;
  try {
    while (at < bytes.length) {
      const parsed = parseRecord(bytes, at, bytes.length, page.offset, "");
      if (
        records.length === 0 &&
        compareBytes(parsed.key, page.firstKey) !== 0
      ) {
        throw new Error("its first record's key is not its first_key");
      }
      const key = strictUtf8.decode(parsed.key);
      parsed.entry.name = key;
      records.push({ key, entry: parsed.entry });
      at = parsed.end;
    }
  } catch (e) {
    const message = e instanceof VzipError ? e.message : (e as Error).message;
    return fail("entry", `page ${index} cannot be parsed: ${message}`);
  }
  return records;
}
