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

import { raceWithAbort, SharedAbortController } from "#src/util/abort.js";

interface Entry<T> {
  promise: Promise<T>;
  controller: SharedAbortController;
  done: boolean;
  size: number;
}

interface PendingRead {
  offset: number;
  length: number;
  signal: AbortSignal;
  resolve: (data: Uint8Array<ArrayBuffer>) => void;
  reject: (reason: unknown) => void;
}

/**
 * Coalesces byte range reads of nearby ranges (e.g. consecutive strips) requested in the same
 * microtask into a single read.  A combined read is aborted only once all of its requesters have
 * aborted.
 */
export class CoalescingRangeReader {
  private pending: PendingRead[] = [];

  constructor(
    private readRange: (
      offset: number,
      length: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array<ArrayBuffer>>,
    private maxGap = 4096,
    private maxLength = 16 * 1024 * 1024,
  ) {}

  read(
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const { promise, resolve, reject } =
      Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    if (this.pending.length === 0) queueMicrotask(() => this.flush());
    this.pending.push({ offset, length, signal, resolve, reject });
    return raceWithAbort(promise, signal);
  }

  private flush() {
    const { maxGap, maxLength } = this;
    const reads = this.pending;
    this.pending = [];
    reads.sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < reads.length; ) {
      const start = reads[i].offset;
      let end = start + reads[i].length;
      let j = i + 1;
      for (; j < reads.length; ++j) {
        const { offset, length } = reads[j];
        const newEnd = Math.max(end, offset + length);
        if (offset > end + maxGap || newEnd - start > maxLength) break;
        end = newEnd;
      }
      this.readGroup(reads.slice(i, j), start, end);
      i = j;
    }
  }

  private readGroup(group: PendingRead[], start: number, end: number) {
    const controller = new SharedAbortController();
    for (const { signal } of group) controller.addConsumer(signal);
    controller.start();
    this.readRange(start, end - start, controller.signal).then(
      (data) => {
        controller[Symbol.dispose]();
        for (const { offset, length, resolve } of group) {
          // Copy, since the buffer may be transferred to a worker for decoding.
          resolve(data.slice(offset - start, offset - start + length));
        }
      },
      (reason) => {
        controller[Symbol.dispose]();
        for (const { reject } of group) reject(reason);
      },
    );
  }
}

/**
 * Small least-recently-used cache of decoded tiles (or strips) that are shared by multiple chunks,
 * such that each is downloaded and decoded only once.  Concurrent requests for the same tile share
 * a single download, which is aborted only once all requesters have aborted.
 */
export class DecodedTileCache<T> {
  private entries = new Map<number, Entry<T>>();
  private totalSize = 0;

  constructor(
    private maxSize: number,
    private getSize: (value: T) => number,
  ) {}

  get(
    key: number,
    signal: AbortSignal,
    compute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { entries } = this;
    const existing = entries.get(key);
    if (existing !== undefined) {
      if (existing.done) {
        // Mark as most recently used.
        entries.delete(key);
        entries.set(key, existing);
        return existing.promise;
      }
      if (!existing.controller.signal.aborted) {
        existing.controller.addConsumer(signal);
        return raceWithAbort(existing.promise, signal);
      }
    }
    const controller = new SharedAbortController();
    controller.addConsumer(signal);
    controller.start();
    const promise = compute(controller.signal);
    const entry: Entry<T> = { promise, controller, done: false, size: 0 };
    entries.set(key, entry);
    promise.then(
      (value) => {
        if (entries.get(key) !== entry) return;
        entry.done = true;
        controller[Symbol.dispose]();
        entry.size = this.getSize(value);
        this.totalSize += entry.size;
        // Mark as most recently used.
        entries.delete(key);
        entries.set(key, entry);
        this.evict(entry);
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return raceWithAbort(promise, signal);
  }

  private evict(keep: Entry<T>) {
    const { entries } = this;
    // The newly completed entry is always retained, even if it exceeds `maxSize` by itself.
    for (const [key, entry] of entries) {
      if (this.totalSize <= this.maxSize) break;
      if (entry === keep || !entry.done) continue;
      entries.delete(key);
      this.totalSize -= entry.size;
    }
  }
}
