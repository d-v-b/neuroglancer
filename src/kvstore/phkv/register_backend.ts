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

import type { SharedKvStoreContextCounterpart } from "#src/kvstore/backend.js";
import { backendOnlyKvStoreProviderRegistry } from "#src/kvstore/backend.js";
import type { KvStoreAdapterProvider } from "#src/kvstore/context.js";
import { KvStoreFileHandle } from "#src/kvstore/index.js";
import { PhkvKvStore } from "#src/kvstore/phkv/backend.js";
import { phkvSchemeProvider } from "#src/kvstore/phkv/scheme.js";
import { ensureNoQueryOrFragmentParameters } from "#src/kvstore/url.js";

function phkvProvider(
  sharedKvStoreContext: SharedKvStoreContextCounterpart,
): KvStoreAdapterProvider {
  return {
    scheme: "phkv",
    description:
      "phkv store (perfect-hash key-value store with byte-range references)",
    getKvStore(parsedUrl, base) {
      ensureNoQueryOrFragmentParameters(parsedUrl);
      return {
        store: new PhkvKvStore(
          sharedKvStoreContext,
          new KvStoreFileHandle(base.store, base.path),
        ),
        path: decodeURIComponent(parsedUrl.suffix ?? ""),
      };
    },
  };
}

backendOnlyKvStoreProviderRegistry.registerKvStoreAdapterProvider(phkvProvider);

// `phkv://<store-url>` is shorthand for `<store-url>|phkv:`.
backendOnlyKvStoreProviderRegistry.registerBaseKvStoreProvider(
  phkvSchemeProvider,
);
