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
 * @file The API of refkv_embed.js, refkv's js/src/embed.ts (see README).
 */

/** A file the host reads: its URL (recorded as the archive's source), its
 * size, and its bytes. */
export interface FileInput {
  url: string;
  size: number;
  /** Exactly `length` bytes at `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** For a VSI input: the file `key` beside it (relative to its directory),
   * or undefined when there is none. */
  open?(key: string): Promise<Omit<FileInput, "url" | "open"> | undefined>;
}

/** refkv's reader policy (refkv's spec/refkv.md, section 6.7). */
export interface Policy {
  schemes?: string[];
  prefixes?: string[];
  allowPrivateHosts?: boolean;
  maxSources?: number;
  maxReads?: number;
}

export interface EmbedOptions {
  /** Record each source's size pin (default true). */
  pins?: boolean;
  /** The reader policy a store URL is listed and read under. */
  policy?: Policy;
}

export interface Virtualized {
  /** The vzip archive. */
  archive: Uint8Array;
  /** The profile that virtualized the input. */
  format: string;
  summary: object;
}

/** Where to fetch refkv_ir.wasm from. */
export function setIrWasmUrl(url: string | URL): void;

/** refkv_ir.wasm itself, compiled by the host, in place of fetching it. */
export function setIrWasmModule(
  module: WebAssembly.Module | Promise<WebAssembly.Module>,
): void;

/** Virtualizes the file `input`, or the store at `input` (an http(s) URL whose
 * path ends in `/`), and writes its vzip archive. Rejects an input of no
 * supported format with an Error whose message says why. */
export function virtualizeToArchive(
  input: FileInput | string,
  options?: EmbedOptions,
): Promise<Virtualized>;

/** Decodes a chunk of the `refkv.fits_tiles` codec (refkv's
 * spec/virtualize/fits.md, section 3.3) with the codec's `configuration` into
 * the pixels of the chunk shape `shape`: little-endian values of the array's
 * data type. Rejects with an Error whose message starts "refkv.fits_tiles: ". */
export function decodeFitsTiles(
  chunk: Uint8Array,
  configuration: unknown,
  shape: number[],
): Promise<Uint8Array>;
