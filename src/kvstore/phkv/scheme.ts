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
 * @file The `phkv://` URL scheme, in the style of Neuroglancer's legacy
 * `zarr://<url>` datasource syntax:
 *
 *   `phkv://<store-url>/<path>`  ==  `<store-url>|phkv:<path>`
 *
 * The store URL ends at the first path segment whose name ends in `.phkv`;
 * the rest is a key path inside the store. For example,
 * `phkv://https://example.com/data.phkv/scale0/zarr.json`. This keeps the
 * boundary unambiguous when Neuroglancer appends paths to a URL string. A
 * store whose name does not end in `.phkv` can be opened with the pipeline
 * form `<store-url>|phkv:<path>`, or as `phkv://<store-url>` (no path).
 */

import type {
  BaseKvStoreProvider,
  KvStoreContext,
} from "#src/kvstore/context.js";
import type { UrlWithParsedScheme } from "#src/kvstore/url.js";

/** Rewrites `phkv://<store-url>` as `<store-url>|phkv:`. */
export function expandPhkvSchemeUrl(url: UrlWithParsedScheme): string {
  const suffix = url.suffix ?? "";
  if (!suffix.startsWith("//") || suffix.length === 2) {
    throw new Error(
      `Invalid URL ${JSON.stringify(url.url)}, expected \`phkv://<store-url>\`, ` +
        "for example `phkv://https://example.com/data.phkv`",
    );
  }
  const rest = suffix.substring(2);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rest)) {
    throw new Error(
      `Invalid URL ${JSON.stringify(url.url)}: the store URL must have a scheme, ` +
        "for example `phkv://https://example.com/data.phkv`",
    );
  }
  // The first segment ending in ".phkv", followed by "/" or the end.
  const m = rest.match(/^(.*?\.phkv)(?:\/(.*))?$/i);
  if (m === null) return `${rest}|phkv:`;
  return `${m[1]}|phkv:${m[2] ?? ""}`;
}

export function phkvSchemeProvider(context: {
  kvStoreContext: KvStoreContext;
}): BaseKvStoreProvider {
  return {
    scheme: "phkv",
    description: "phkv store (phkv://<store-url>)",
    getKvStore(url) {
      return context.kvStoreContext.getKvStore(expandPhkvSchemeUrl(url));
    },
  };
}
