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
 * @file Merges the reads of a url source that wait at the same time into one
 * request, whichever value they belong to. Neuroglancer reads each chunk, and
 * each inner chunk of a shard, with a read of its own, so a file of many short
 * chunks would otherwise cost one request per chunk.
 *
 * The rules are those of refkv's readers:
 * https://github.com/d-v-b/refkv/blob/main/spec/refkv.md#63-resolving-a-reference
 */

import type { ProgressOptions } from "#src/util/progress_listener.js";

/**
 * Reads of the same url source at most this far apart are combined into one
 * request. A Concat of many short ranges, such as one per image row, would
 * otherwise cost one request per range.
 */
export const MERGE_GAP = 1 << 16;

/**
 * A request serving reads of different values also fetches at most this many
 * times the bytes they ask for, plus `MERGE_GAP`...
 */
export const MERGE_AMPLIFICATION = 4;
/**
 * ...and at most the bytes waiting over this many connections, between these
 * lengths, so that a batch that reads much keeps connections busy.
 */
const MERGE_CONNECTIONS = 8;
const MERGE_MIN_RUN = 1 << 20;
const MERGE_MAX_RUN = 32 << 20;
/** How long, in milliseconds, a read waits for the reads near it. */
export const MERGE_WINDOW = 2;
/**
 * The longest, in milliseconds, a read waits for a request near it, so that a
 * stalled or very long request does not stall the reads beside it.
 */
export const MERGE_MAX_WAIT = 1000;

/**
 * `reads` of one source, as the runs that one request each serves, in order of
 * start. A read joins the run before it if it starts at most `MERGE_GAP` bytes
 * after the run's end, and the run then fetches at most `MERGE_AMPLIFICATION`
 * times the bytes its reads ask for, plus `MERGE_GAP`, and at most `longest`
 * bytes. A read is never cut, so a longer one is a run of its own.
 */
export function mergedRuns<T extends { start: number; end: number }>(
  reads: T[],
  longest: number,
): T[][] {
  const sorted = [...reads].sort((x, y) => x.start - y.start || x.end - y.end);
  const runs: T[][] = [];
  let start = 0;
  let end = 0;
  let asked = 0;
  for (const read of sorted) {
    const fresh = Math.max(read.end - Math.max(read.start, end), 0);
    const span = Math.max(end, read.end) - start;
    if (
      runs.length > 0 &&
      read.start - end <= MERGE_GAP &&
      span <= longest &&
      span <= MERGE_AMPLIFICATION * (asked + fresh) + MERGE_GAP
    ) {
      runs[runs.length - 1].push(read);
      asked += fresh;
      end = Math.max(end, read.end);
    } else {
      runs.push([read]);
      start = read.start;
      end = read.end;
      asked = read.end - read.start;
    }
  }
  return runs;
}

/** Reads bytes `[start, end)` of a source, checking its pins. */
export type ReadSource = (
  source: number,
  start: number,
  end: number,
  options: Partial<ProgressOptions>,
) => Promise<Uint8Array>;

interface Read {
  source: number;
  start: number;
  end: number;
  options: Partial<ProgressOptions>;
  resolve: (data: Uint8Array) => void;
  reject: (reason: unknown) => void;
  stopListening: (() => void) | undefined;
  /** It has its result, or its caller has stopped waiting for one. */
  settled: boolean;
  /** The request serving it, while one does. */
  run: Run | undefined;
  /** When it began to wait, in milliseconds. */
  since: number;
}

/** One request, and what remains of the reads it serves. */
interface Run {
  reads: Read[];
  start: number;
  end: number;
  /** The bytes that the reads still waiting for it ask for. */
  asked: number;
  numWaiting: number;
  controller: AbortController;
  /** It no longer serves anyone; its result, whatever it is, is dropped. */
  abandoned: boolean;
}

function settle(read: Read) {
  read.settled = true;
  read.run = undefined;
  read.stopListening?.();
}

/**
 * The reads of one archive's url sources waiting to merge, or being served.
 *
 * A read's caller can stop waiting at any time, and Neuroglancer stops often:
 * it cancels the chunks a navigation leaves behind. A cancelled read rejects
 * at once, whatever else its request serves, so that the chunk's download slot
 * is free at once. The request itself:
 *
 * - is not sent, if no read is left when the wait ends;
 * - is aborted when its last read leaves;
 * - is also aborted when the reads left no longer justify its length, by the
 *   limit a new run must meet, `MERGE_AMPLIFICATION` times their bytes plus
 *   `MERGE_GAP`. They wait again, and merge with whatever else then waits, so
 *   the reads that one tick cancels together send nothing, and a navigation
 *   does not keep up to `MERGE_MAX_RUN` bytes coming for one small chunk.
 */
export class SharedReads {
  private waiting = new Map<number, Read[]>();
  private flushPending = false;
  /** Some reads whose wait has ended are waiting for a request to end. */
  private held = false;
  private releasePending = false;
  /** The requests in flight, by source. */
  private serving = new Map<number, Set<Run>>();

  constructor(private readSource: ReadSource) {}

  read(
    source: number,
    start: number,
    end: number,
    options: Partial<ProgressOptions>,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      signal?.throwIfAborted();
      const read: Read = {
        source,
        start,
        end,
        options,
        resolve,
        reject,
        stopListening: undefined,
        settled: false,
        run: undefined,
        since: 0,
      };
      if (signal !== undefined) {
        const onAbort = () => this.leave(read, signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        read.stopListening = () => signal.removeEventListener("abort", onAbort);
      }
      this.wait(read);
    });
  }

  private wait(read: Read) {
    read.since = Date.now();
    const reads = this.waiting.get(read.source);
    if (reads === undefined) this.waiting.set(read.source, [read]);
    else reads.push(read);
    if (!this.flushPending) {
      this.flushPending = true;
      setTimeout(() => {
        this.flushPending = false;
        this.flush();
      }, MERGE_WINDOW);
    }
  }

  /**
   * Starts the requests that serve the reads waiting. A read near a request
   * already in flight waits for it to end, and merges with the reads that come
   * meanwhile: a viewer starts the next chunks as the last ones finish, a few
   * at a time, and those are the chunks beside them. Reads far from any request
   * do not wait, so reads that cannot merge are as concurrent as they were. A
   * read inside a request in flight joins it, since its bytes are on their way.
   */
  private flush() {
    const { waiting } = this;
    const now = Date.now();
    for (const [source, all] of Array.from(waiting)) {
      // Not the requests this loop starts, which share out one batch of reads.
      const serving = Array.from(this.serving.get(source) ?? []);
      const reads = all.filter(
        (read) => !read.settled && !SharedReads.join(read, serving),
      );
      const bytes = reads.reduce((n, r) => n + (r.end - r.start), 0);
      const longest = Math.min(
        Math.max(bytes / MERGE_CONNECTIONS, MERGE_MIN_RUN),
        MERGE_MAX_RUN,
      );
      const held: Read[] = [];
      for (const run of mergedRuns(reads, longest)) {
        const start = run[0].start;
        const end = run.reduce((e, r) => Math.max(e, r.end), start);
        const near = serving.some(
          (other) =>
            !other.abandoned &&
            other.start - end <= MERGE_GAP &&
            start - other.end <= MERGE_GAP,
        );
        const patient = run.every((r) => now - r.since < MERGE_MAX_WAIT);
        if (near && patient) held.push(...run);
        else void this.serve(source, run);
      }
      if (held.length > 0) waiting.set(source, held);
      else waiting.delete(source);
    }
    this.held = waiting.size > 0;
    if (this.held && !this.releasePending) {
      this.releasePending = true;
      setTimeout(() => {
        this.releasePending = false;
        this.flush();
      }, MERGE_MAX_WAIT);
    }
  }

  /** Adds `read` to a request in flight that covers it, if there is one. */
  private static join(read: Read, serving: Run[]) {
    const run = serving.find(
      (other) =>
        !other.abandoned && other.start <= read.start && read.end <= other.end,
    );
    if (run === undefined) return false;
    run.reads.push(read);
    run.asked += read.end - read.start;
    ++run.numWaiting;
    read.run = run;
    return true;
  }

  /** Called when the caller of `read` stops waiting for it. */
  private leave(read: Read, reason: unknown) {
    if (read.settled) return;
    const { run } = read;
    settle(read);
    read.reject(reason);
    if (run === undefined) return;
    run.asked -= read.end - read.start;
    --run.numWaiting;
    if (
      run.numWaiting > 0 &&
      run.end - run.start <= MERGE_AMPLIFICATION * run.asked + MERGE_GAP
    ) {
      return;
    }
    run.abandoned = true;
    run.controller.abort(reason);
    for (const other of run.reads) {
      if (other.settled) continue;
      other.run = undefined;
      this.wait(other);
    }
  }

  /**
   * Reads `reads` in one request, and gives each its bytes. A request ends
   * where its last read ends, so it may fail where that read alone would. The
   * others must not fail with it, so each read of a request that fails is read
   * on its own, and gets its own result.
   */
  private async serve(source: number, reads: Read[]) {
    const start = reads[0].start;
    const end = reads.reduce((e, r) => Math.max(e, r.end), start);
    const controller = new AbortController();
    const run: Run = {
      reads,
      start,
      end,
      asked: reads.reduce((n, r) => n + (r.end - r.start), 0),
      numWaiting: reads.length,
      controller,
      abandoned: false,
    };
    for (const read of reads) read.run = run;
    let serving = this.serving.get(source);
    if (serving === undefined) this.serving.set(source, (serving = new Set()));
    serving.add(run);
    let data: Uint8Array;
    try {
      data = await this.readSource(source, start, end, {
        signal: controller.signal,
      });
    } catch (e) {
      if (run.abandoned) return;
      for (const read of reads) {
        if (read.settled) continue;
        if (reads.length > 1) {
          read.run = undefined;
          this.readAlone(read);
        } else {
          settle(read);
          read.reject(e);
        }
      }
      return;
    } finally {
      serving.delete(run);
      if (serving.size === 0) this.serving.delete(source);
      // Reads still in their wait are left to it: the reads near them are
      // about to come.
      if (this.held) this.flush();
    }
    if (run.abandoned) return;
    for (const read of reads) {
      if (read.settled) continue;
      settle(read);
      read.resolve(data.subarray(read.start - start, read.end - start));
    }
  }

  /** Reads `read` by itself, under its caller's own signal. */
  private readAlone(read: Read) {
    this.readSource(read.source, read.start, read.end, read.options).then(
      (data) => {
        if (read.settled) return;
        settle(read);
        read.resolve(data);
      },
      (e) => {
        if (read.settled) return;
        settle(read);
        read.reject(e);
      },
    );
  }
}
