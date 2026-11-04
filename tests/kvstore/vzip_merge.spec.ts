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

import "#src/kvstore/http/register_frontend.js";
import "#src/kvstore/vzip/register_frontend.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReadSource } from "#src/kvstore/vzip/merge.js";
import {
  MERGE_GAP,
  MERGE_MAX_WAIT,
  MERGE_WINDOW,
  mergedRuns,
  SharedReads,
} from "#src/kvstore/vzip/merge.js";
import { constantFixture } from "#tests/fixtures/fixture.js";
import { httpServerFixture } from "#tests/fixtures/http_server.js";
import { getTestFiles, TEST_DATA_DIR } from "#tests/kvstore/test_data.js";
import { sharedKvStoreContext } from "#tests/kvstore/test_util.js";

const MiB = 1 << 20;

test("mergedRuns", () => {
  const runs = (reads: [number, number][], longest = 32 * MiB) =>
    mergedRuns(
      reads.map(([start, end]) => ({ start, end })),
      longest,
    ).map((run) => run.map((read) => [read.start, read.end]));
  // Adjacent, out of order, and overlapping reads merge, in order of start.
  expect(
    runs([
      [10, 20],
      [0, 10],
      [15, 25],
    ]),
  ).toEqual([
    [
      [0, 10],
      [10, 20],
      [15, 25],
    ],
  ]);
  // A gap of exactly MERGE_GAP merges; one byte more does not.
  const big = MERGE_GAP;
  expect(
    runs([
      [0, big],
      [big + MERGE_GAP, 2 * big + MERGE_GAP],
    ]).length,
  ).toEqual(1);
  expect(
    runs([
      [0, big],
      [big + MERGE_GAP + 1, 2 * big + MERGE_GAP + 1],
    ]).length,
  ).toEqual(2);
  // Short reads, each within the gap of the last, stop at the amplification
  // limit: 4 times the bytes asked for, plus MERGE_GAP.
  expect(
    runs([
      [0, 1],
      [MERGE_GAP, MERGE_GAP + 1],
    ]).length,
  ).toEqual(1);
  expect(
    runs([
      [0, 1],
      [MERGE_GAP, MERGE_GAP + 1],
      [2 * MERGE_GAP, 2 * MERGE_GAP + 1],
    ]),
  ).toEqual([
    [
      [0, 1],
      [MERGE_GAP, MERGE_GAP + 1],
    ],
    [[2 * MERGE_GAP, 2 * MERGE_GAP + 1]],
  ]);
  // `longest` splits a run, but never a read.
  expect(
    runs(
      [
        [0, 100],
        [100, 200],
      ],
      150,
    ).length,
  ).toEqual(2);
  expect(runs([[0, 1000]], 150)).toEqual([[[0, 1000]]]);
  expect(runs([])).toEqual([]);
});

/** A `ReadSource` that the test finishes by hand. */
function fakeSource() {
  const calls: {
    source: number;
    start: number;
    end: number;
    signal: AbortSignal | undefined;
    succeed: () => void;
    fail: (e: Error) => void;
  }[] = [];
  const readSource = vi.fn<ReadSource>(
    (source, start, end, { signal }) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        calls.push({
          source,
          start,
          end,
          signal,
          succeed: () => resolve(bytes(start, end)),
          fail: reject,
        });
      }),
  );
  return { calls, readSource, shared: new SharedReads(readSource) };
}

/** Bytes whose values say where in the source they came from. */
function bytes(start: number, end: number) {
  const out = new Uint8Array(end - start);
  for (let i = 0; i < out.length; ++i) out[i] = (start + i) % 251;
  return out;
}

function aborted() {
  return new DOMException("chunk download cancelled", "AbortError");
}

describe("SharedReads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const elapse = () => vi.advanceTimersByTimeAsync(MERGE_WINDOW);

  test("reads waiting together share a request, by source", async () => {
    const { calls, readSource, shared } = fakeSource();
    const reads = [
      shared.read(0, 100, 110, {}),
      shared.read(0, 110, 120, {}),
      shared.read(0, 130, 140, {}),
      // Near the others, in another entry of the source table, whose pins may
      // differ.
      shared.read(1, 100, 110, {}),
      // Too far from the others to save a request.
      shared.read(0, 100 + 16 * MERGE_GAP, 110 + 16 * MERGE_GAP, {}),
    ];
    expect(readSource).not.toHaveBeenCalled();
    await elapse();
    expect(calls.map((c) => [c.source, c.start, c.end])).toEqual([
      [0, 100, 140],
      [0, 100 + 16 * MERGE_GAP, 110 + 16 * MERGE_GAP],
      [1, 100, 110],
    ]);
    for (const call of calls) call.succeed();
    expect(await Promise.all(reads)).toEqual([
      bytes(100, 110),
      bytes(110, 120),
      bytes(130, 140),
      bytes(100, 110),
      bytes(100 + 16 * MERGE_GAP, 110 + 16 * MERGE_GAP),
    ]);
  });

  test("a read near a request in flight waits for it, and merges meanwhile", async () => {
    const { calls, shared } = fakeSource();
    const first = shared.read(0, 0, 10, {});
    await elapse();
    expect(calls.length).toEqual(1);
    const held = [shared.read(0, 10, 20, {})];
    await elapse();
    held.push(shared.read(0, 20, 30, {}));
    await elapse();
    expect(calls.length).toEqual(1);
    calls[0].succeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([[10, 30]]);
    calls[1].succeed();
    expect(await first).toEqual(bytes(0, 10));
    expect(await Promise.all(held)).toEqual([bytes(10, 20), bytes(20, 30)]);
  });

  test("a read inside a request in flight joins it", async () => {
    const { calls, readSource, shared } = fakeSource();
    const outer = [shared.read(0, 0, 10, {}), shared.read(0, 90, 100, {})];
    await elapse();
    const inside = shared.read(0, 40, 50, {});
    await elapse();
    expect(readSource).toHaveBeenCalledTimes(1);
    calls[0].succeed();
    expect(await inside).toEqual(bytes(40, 50));
    await Promise.all(outer);
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  test("a read that joined a request keeps it alive, and gets its own result if it fails", async () => {
    const { calls, shared } = fakeSource();
    const controller = new AbortController();
    const first = shared.read(0, 0, 10, { signal: controller.signal });
    const last = shared.read(0, 90, 100, { signal: controller.signal });
    await elapse();
    const joined = shared.read(0, 40, 50, {});
    await elapse();
    controller.abort(aborted());
    await expect(first).rejects.toThrow();
    await expect(last).rejects.toThrow();
    expect(calls[0].signal!.aborted).toBe(false);
    calls[0].fail(new Error("failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([[40, 50]]);
    calls[1].fail(new Error("its own failure"));
    await expect(joined).rejects.toThrow("its own failure");
  });

  test("a read stops waiting for a request near it after MERGE_MAX_WAIT", async () => {
    const { calls, shared } = fakeSource();
    const stalled = shared.read(0, 0, 10, {});
    await elapse();
    const held = shared.read(0, 10, 20, {});
    await vi.advanceTimersByTimeAsync(MERGE_MAX_WAIT - MERGE_WINDOW);
    expect(calls.length).toEqual(1);
    await vi.advanceTimersByTimeAsync(2 * MERGE_MAX_WAIT);
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([[10, 20]]);
    for (const call of calls) call.succeed();
    await Promise.all([stalled, held]);
  });

  test("a read far from the requests in flight, or of another source, does not wait", async () => {
    const { calls, shared } = fakeSource();
    const far = 2 * MERGE_GAP;
    const reads = Array.from({ length: 100 }, (_, i) =>
      shared.read(0, i * far, i * far + 1, {}),
    );
    await elapse();
    expect(calls.length).toEqual(100);
    reads.push(
      shared.read(0, 100 * far, 100 * far + 1, {}),
      shared.read(1, 0, 1, {}),
    );
    await elapse();
    expect(calls.length).toEqual(102);
    for (const call of calls) call.succeed();
    await Promise.all(reads);
  });

  test("a request that batch splits goes out whole, not one piece at a time", async () => {
    const { calls, shared } = fakeSource();
    const size = MiB;
    const reads = Array.from({ length: 40 }, (_, i) =>
      shared.read(0, i * size, (i + 1) * size, {}),
    );
    await elapse();
    expect(calls.length).toEqual(8);
    for (const call of calls) call.succeed();
    await Promise.all(reads);
  });

  test("a read near a request that was abandoned does not wait for it", async () => {
    const { calls, shared } = fakeSource();
    const controller = new AbortController();
    const gone = shared.read(0, 0, 10, { signal: controller.signal });
    await elapse();
    const reason = aborted();
    controller.abort(reason);
    await expect(gone).rejects.toBe(reason);
    const next = shared.read(0, 10, 20, {});
    await elapse();
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([[10, 20]]);
    calls[1].succeed();
    expect(await next).toEqual(bytes(10, 20));
  });

  test("a failed shared request gives each read its own result", async () => {
    const { calls, shared } = fakeSource();
    const good = shared.read(0, 0, 10, {});
    const bad = shared.read(0, 10, 20, {});
    await elapse();
    expect(calls.length).toEqual(1);
    calls[0].fail(new Error("the object is shorter than the range"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([
      [0, 10],
      [10, 20],
    ]);
    calls[1].succeed();
    calls[2].fail(new Error("its own failure"));
    expect(await good).toEqual(bytes(0, 10));
    await expect(bad).rejects.toThrow("its own failure");
  });

  test("a read alone is not retried", async () => {
    const { calls, readSource, shared } = fakeSource();
    const read = shared.read(0, 0, 10, {});
    await elapse();
    calls[0].fail(new Error("failure"));
    await expect(read).rejects.toThrow("failure");
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  test("a read already cancelled sends nothing", async () => {
    const { readSource, shared } = fakeSource();
    const reason = aborted();
    await expect(
      shared.read(0, 0, 10, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await elapse();
    expect(readSource).not.toHaveBeenCalled();
  });

  test("reads cancelled during the wait send nothing", async () => {
    const { calls, readSource, shared } = fakeSource();
    const controller = new AbortController();
    const reason = aborted();
    const gone = shared.read(0, 0, 10, { signal: controller.signal });
    const kept = shared.read(0, 2 * MERGE_GAP, 2 * MERGE_GAP + 10, {});
    controller.abort(reason);
    await expect(gone).rejects.toBe(reason);
    await elapse();
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(calls[0].start).toEqual(2 * MERGE_GAP);
    calls[0].succeed();
    await kept;
  });

  test("a cancelled read rejects at once, and the others keep the request", async () => {
    const { calls, readSource, shared } = fakeSource();
    const controller = new AbortController();
    const reason = aborted();
    const gone = shared.read(0, 0, 10, { signal: controller.signal });
    const kept = shared.read(0, 10, 20, {});
    await elapse();
    controller.abort(reason);
    await expect(gone).rejects.toBe(reason);
    expect(calls[0].signal!.aborted).toBe(false);
    calls[0].succeed();
    expect(await kept).toEqual(bytes(10, 20));
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  test("the last read to leave aborts the request", async () => {
    const { calls, readSource, shared } = fakeSource();
    const controllers = [new AbortController(), new AbortController()];
    const reason = aborted();
    const reads = controllers.map((controller, i) =>
      shared.read(0, i * 10, i * 10 + 10, { signal: controller.signal }),
    );
    await elapse();
    controllers[0].abort(reason);
    await expect(reads[0]).rejects.toBe(reason);
    expect(calls[0].signal!.aborted).toBe(false);
    controllers[1].abort(reason);
    await expect(reads[1]).rejects.toBe(reason);
    expect(calls[0].signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MERGE_WINDOW);
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  test("a request the reads left no longer justify is aborted, and they merge again", async () => {
    const { calls, shared } = fakeSource();
    const size = 100 * 1024;
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const reads = controllers.map((controller, i) =>
      shared.read(0, i * size, (i + 1) * size, { signal: controller.signal }),
    );
    await elapse();
    expect(calls.map((c) => [c.start, c.end])).toEqual([[0, 10 * size]]);
    // Three reads still justify 10 of theirs: 4 x 3 x size + MERGE_GAP.
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      controllers[i].abort(aborted());
      await expect(reads[i]).rejects.toThrow();
    }
    expect(calls[0].signal!.aborted).toBe(false);
    // Two do not.
    controllers[8].abort(aborted());
    await expect(reads[8]).rejects.toThrow();
    expect(calls[0].signal!.aborted).toBe(true);
    // The reads left wait again, with whatever comes meanwhile...
    const near = shared.read(0, size, 2 * size, {});
    // ...and the rest of a burst of cancellations sends nothing.
    controllers[9].abort(aborted());
    await expect(reads[9]).rejects.toThrow();
    await elapse();
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([
      [0, 2 * size],
    ]);
    calls[1].succeed();
    expect(await reads[0]).toEqual(bytes(0, size));
    expect(await near).toEqual(bytes(size, 2 * size));
  });

  test("a read leaving during the retry cancels only itself", async () => {
    const { calls, shared } = fakeSource();
    const controller = new AbortController();
    const reason = aborted();
    const gone = shared.read(0, 0, 10, { signal: controller.signal });
    const kept = shared.read(0, 10, 20, {});
    await elapse();
    calls[0].fail(new Error("failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1].signal).toBe(controller.signal);
    controller.abort(reason);
    await expect(gone).rejects.toBe(reason);
    expect(calls[1].signal!.aborted).toBe(true);
    calls[2].succeed();
    expect(await kept).toEqual(bytes(10, 20));
  });

  test("a read cancelled before a failure is not retried", async () => {
    const { calls, shared } = fakeSource();
    const controller = new AbortController();
    const gone = shared.read(0, 0, 10, { signal: controller.signal });
    const kept = shared.read(0, 10, 20, {});
    await elapse();
    controller.abort(aborted());
    await expect(gone).rejects.toThrow();
    calls[0].fail(new Error("failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(1).map((c) => [c.start, c.end])).toEqual([[10, 20]]);
    calls[1].succeed();
    expect(await kept).toEqual(bytes(10, 20));
  });
});

describe("through the store", () => {
  const serverFixture = httpServerFixture(constantFixture(TEST_DATA_DIR));

  async function requestsTo(file: string, body: () => Promise<void>) {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      await body();
      return spy.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).endsWith(file),
      ).length;
    } finally {
      spy.mockRestore();
    }
  }

  async function read(archive: string, key: string, signal?: AbortSignal) {
    const { kvStoreContext } = await sharedKvStoreContext();
    const url =
      (await serverFixture.serverUrl()) + `vzip/${archive}|vzip:${key}`;
    const response = await kvStoreContext.read(url, {
      throwIfMissing: true,
      signal,
    });
    return Buffer.from(await response.response.arrayBuffer());
  }

  // The non-empty values that read a url range of files.blob.
  const URL_KEYS = ["a", "b"];

  test("reads of different keys share a request, with the right bytes", async () => {
    const files = await getTestFiles();
    // Opens the archive first, so that the reads below start together.
    await read("files.vzip", "c");
    const n = await requestsTo("/files.blob", async () => {
      const values = await Promise.all(
        URL_KEYS.map((key) => read("files.vzip", key)),
      );
      values.forEach((value, i) =>
        expect(value.equals(files.get(URL_KEYS[i])!)).toBe(true),
      );
    });
    expect(n).toEqual(1);
  });

  test("reads of two source entries do not merge, and a failing pin fails only its own", async () => {
    const b = (await getTestFiles()).get("b")!;
    await read("pins.vzip", "size_ok");
    const n = await requestsTo("/files.blob", async () => {
      const [good, bad] = await Promise.allSettled([
        read("pins.vzip", "size_ok"),
        read("pins.vzip", "size_wrong"),
      ]);
      expect(good.status === "fulfilled" && good.value.equals(b)).toBe(true);
      expect(bad.status).toEqual("rejected");
    });
    expect(n).toEqual(2);
  });

  test("a shared request that fails is made again, read by read", async () => {
    const files = await getTestFiles();
    await read("files.vzip", "c");
    const networkFetch = globalThis.fetch;
    let failed = false;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/files.blob") && !failed) {
          failed = true;
          return new Response(null, { status: 503 });
        }
        return networkFetch(input, init);
      });
    try {
      const values = await Promise.all(
        URL_KEYS.map((key) => read("files.vzip", key)),
      );
      values.forEach((value, i) =>
        expect(value.equals(files.get(URL_KEYS[i])!)).toBe(true),
      );
      const blobRequests = spy.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).endsWith(
          "/files.blob",
        ),
      );
      expect(blobRequests.length).toEqual(1 + URL_KEYS.length);
    } finally {
      spy.mockRestore();
    }
  });

  test("a cancelled read rejects, and leaves the others their bytes", async () => {
    const files = await getTestFiles();
    await read("files.vzip", "c");
    const controller = new AbortController();
    const reason = new DOMException("chunk download cancelled", "AbortError");
    const networkFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/files.blob")) controller.abort(reason);
        return networkFetch(input, init);
      });
    try {
      const gone = read("files.vzip", "a", controller.signal);
      const kept = read("files.vzip", "b");
      await expect(gone).rejects.toThrow(/abort/i);
      expect((await kept).equals(files.get("b")!)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
