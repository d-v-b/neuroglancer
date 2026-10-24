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
 * @file refkv's Rust core, as the vendored bundle (refkv_embed.js; see README)
 * exposes it, with its wasm module found: fetched from beside this module,
 * where the build emits it, or under Node (tests), which cannot fetch a file:
 * URL, read from disk.
 */

import {
  setIrWasmModule,
  setIrWasmUrl,
} from "#src/third_party/refkv/refkv_embed.js";

// Node (the tests): a bundler gives `import.meta.url` as the source's file:
// URL in a browser build too, so it does not tell them apart
const node = (globalThis as { process?: { versions?: { node?: string } } })
  .process?.versions?.node;
if (node !== undefined && import.meta.url.startsWith("file:")) {
  // the file beside this module, as a file: URL (which Node reads on every
  // system), built so that a bundler does not take it for an asset (vite, for
  // the tests, would serve it over http instead)
  const file = new URL(import.meta.url.replace(/[^/]*$/, "refkv_ir.wasm"));
  const fs = "node:fs";
  setIrWasmModule(
    import(/* webpackIgnore: true */ fs).then((m) =>
      WebAssembly.compile(m.readFileSync(file)),
    ),
  );
} else {
  setIrWasmUrl(new URL("./refkv_ir.wasm", import.meta.url));
}

export {
  decodeFitsTiles,
  virtualizeToArchive,
} from "#src/third_party/refkv/refkv_embed.js";
export type { FileInput } from "#src/third_party/refkv/refkv_embed.js";
