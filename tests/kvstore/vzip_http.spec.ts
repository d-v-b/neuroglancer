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

// What a browser does with a range of an object stored with a
// Content-Encoding, as src/kvstore/vzip/http.ts says: measured in Chromium,
// Firefox and WebKit against a server that answers as S3 does.

import { afterEach, expect, test, vi } from "vitest";
import { readHttpRange } from "#src/kvstore/vzip/http.js";

const URL = "https://example.test/object";

function respond(
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  type: ResponseType = "default",
) {
  const response = new Response(body, { status: 206, headers });
  Object.defineProperty(response, "type", { value: type });
  vi.stubGlobal("fetch", async () => response);
}

function read() {
  return readHttpRange(URL, 0, 100, {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("refuses a response whose Content-Encoding shows", async () => {
  // Firefox and WebKit, where the server exposes the header: the stored
  // range's total is right, and the body is what they decoded
  respond(new Uint8Array(100), {
    "Content-Encoding": "br",
    "Content-Range": "bytes 0-99/100",
  });
  await expect(read()).rejects.toThrow('response has Content-Encoding "br"');
});

test("refuses a cross-origin body decoded to another length", async () => {
  // Firefox and WebKit, where it does not: S3 exposes only ETag
  respond(new Uint8Array(5000), {}, "cors");
  await expect(read()).rejects.toThrow(
    "206 of 5000 bytes for [0, 100), as a browser gives for an object stored with a Content-Encoding",
  );
});

test("names the coding when a request fails", async () => {
  // Chromium: ERR_CONTENT_DECODING_FAILED
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(read()).rejects.toThrow(
    `${URL}: Failed to fetch (Chromium says so too of an object stored with a Content-Encoding`,
  );
});
