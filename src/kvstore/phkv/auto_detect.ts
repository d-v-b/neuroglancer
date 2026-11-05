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

import type {
  AutoDetectFileOptions,
  AutoDetectMatch,
  AutoDetectRegistry,
} from "#src/kvstore/auto_detect.js";
import { isPhkvSuffix, SUPERBLOCK_SIZE } from "#src/kvstore/phkv/metadata.js";

// A standalone phkv store ends with its superblock: "PHKV", its CRC-32C, and
// distance 0 (the phkv spec's §17.1).
async function detectPhkv(
  options: AutoDetectFileOptions,
): Promise<AutoDetectMatch[]> {
  const { suffix } = options;
  if (suffix === undefined || !isPhkvSuffix(suffix)) return [];
  return [{ suffix: "phkv:", description: "phkv store" }];
}

export function registerAutoDetect(registry: AutoDetectRegistry) {
  registry.registerFileFormat({
    prefixLength: 0,
    suffixLength: SUPERBLOCK_SIZE,
    match: detectPhkv,
  });
}
