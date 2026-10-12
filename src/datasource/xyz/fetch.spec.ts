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

import { describe, expect, it } from "vitest";
import { readTileWithRetry } from "#src/datasource/xyz/fetch.js";
import type { FileHandle } from "#src/kvstore/index.js";
import { NotFoundError } from "#src/kvstore/index.js";
import { HttpError } from "#src/util/http_request.js";

const handle = {
  getUrl: () => "https://tiles.example/1/2/3.png",
} as FileHandle;

function notFound(status: number) {
  return new NotFoundError(handle, {
    cause: new HttpError("https://tiles.example/1/2/3.png", status, ""),
  });
}

/**
 * Returns a read function that fails with the specified errors before succeeding.
 */
function makeRead(errors: unknown[]) {
  let calls = 0;
  const read = async () => {
    const error = errors[calls++];
    if (error !== undefined) throw error;
    return "tile";
  };
  return { read, getCalls: () => calls };
}

const options = { delay: () => 0 };

describe("readTileWithRetry", () => {
  it("returns tiles, treats 403/404 as missing, and retries network errors", async () => {
    const signal = new AbortController().signal;
    expect(await readTileWithRetry(makeRead([]).read, signal, options)).toBe(
      "tile",
    );
    for (const status of [403, 404]) {
      const { read, getCalls } = makeRead([notFound(status)]);
      expect(await readTileWithRetry(read, signal, options)).toBe(undefined);
      expect(getCalls()).toBe(1);
    }
    // Network or CORS errors (status 0), e.g. throttled responses without CORS headers.
    const { read, getCalls } = makeRead([notFound(0), notFound(0)]);
    expect(await readTileWithRetry(read, signal, options)).toBe("tile");
    expect(getCalls()).toBe(3);
  });

  it("throws network errors once the attempts are exhausted", async () => {
    const { read, getCalls } = makeRead(Array(10).fill(notFound(0)));
    await expect(
      readTileWithRetry(read, new AbortController().signal, {
        ...options,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(getCalls()).toBe(3);
  });

  it("throws other errors without retrying", async () => {
    const { read, getCalls } = makeRead([new Error("decode failed")]);
    await expect(
      readTileWithRetry(read, new AbortController().signal, options),
    ).rejects.toThrow("decode failed");
    expect(getCalls()).toBe(1);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { read, getCalls } = makeRead([]);
    await expect(
      readTileWithRetry(read, controller.signal, options),
    ).rejects.toThrow();
    expect(getCalls()).toBe(0);
  });
});
