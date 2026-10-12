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
 * @file Fetching of map tiles, distinguishing missing tiles from transient failures.
 */

import { NotFoundError } from "#src/kvstore/index.js";
import { HttpError, pickDelay } from "#src/util/http_request.js";

/**
 * Maximum number of attempts to fetch a tile that fails due to a network error.
 */
export const MAX_TILE_FETCH_ATTEMPTS = 5;

/**
 * Indicates whether a tile read failed because the tile does not exist (HTTP 403 or 404), as
 * opposed to a network or CORS error (HTTP status 0), which may be transient: tile servers may
 * reject bursts of requests with responses lacking CORS headers, which are indistinguishable from
 * network errors.
 */
export function isMissingTileError(error: unknown): boolean {
  if (!(error instanceof NotFoundError)) return false;
  const { cause } = error;
  return !(cause instanceof HttpError) || cause.status !== 0;
}

/**
 * Reads a tile using `read`, which must throw `NotFoundError` if the tile is missing.  Returns
 * `undefined` if the tile is missing, and retries (with exponential backoff) reads that fail due
 * to network errors, throwing the error once the attempts are exhausted.
 */
export async function readTileWithRetry<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
  options: {
    maxAttempts?: number;
    delay?: (attempt: number) => number;
  } = {},
): Promise<T | undefined> {
  const { maxAttempts = MAX_TILE_FETCH_ATTEMPTS, delay = pickDelay } = options;
  for (let attempt = 0; ; ++attempt) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (isMissingTileError(error)) return undefined;
      if (!(error instanceof NotFoundError) || attempt + 1 >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
    }
  }
}
