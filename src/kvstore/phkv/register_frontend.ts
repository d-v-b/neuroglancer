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

import type { KvStoreAdapterProvider } from "#src/kvstore/context.js";
import type { SharedKvStoreContext } from "#src/kvstore/frontend.js";
import { frontendOnlyKvStoreProviderRegistry } from "#src/kvstore/frontend.js";
import { KvStoreFileHandle } from "#src/kvstore/index.js";
import { registerAutoDetect } from "#src/kvstore/phkv/auto_detect.js";
import { PhkvKvStore } from "#src/kvstore/phkv/frontend.js";
import { phkvSchemeProvider } from "#src/kvstore/phkv/scheme.js";
import { ensureNoQueryOrFragmentParameters } from "#src/kvstore/url.js";

function phkvProvider(
  sharedKvStoreContext: SharedKvStoreContext,
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

frontendOnlyKvStoreProviderRegistry.registerKvStoreAdapterProvider(
  phkvProvider,
);

// `phkv://<store-url>` is shorthand for `<store-url>|phkv:`.
frontendOnlyKvStoreProviderRegistry.registerBaseKvStoreProvider(
  phkvSchemeProvider,
);

registerAutoDetect(frontendOnlyKvStoreProviderRegistry.autoDetectRegistry);
