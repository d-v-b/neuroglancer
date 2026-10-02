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

import { expect, test } from "vitest";
import { JpegDecoder } from "#src/third_party/jpgjs/jpg.js";

declare const TEST_DATA_SERVER: string;

async function fixture(name: string) {
  const get = async (ext: string) => {
    const response = await fetch(
      `${TEST_DATA_SERVER}codec/jpeg/${name}.${ext}`,
    );
    expect(response.ok).toBe(true);
    return new Uint8Array(await response.arrayBuffer());
  };
  const info = JSON.parse(new TextDecoder().decode(await get("json"))) as {
    shape: number[];
  };
  return { encoded: await get("jpg"), expected: await get("raw"), info };
}

test("decodes like libjpeg, honouring the Adobe colour transform", async () => {
  // libjpeg (imagecodecs) wrote the expected pixels. This decoder upsamples
  // chroma more simply, so single pixels at colour edges can differ a lot,
  // but on average the images agree within a few levels. Without the Adobe
  // marker's transform 0, RGB samples would be converted as YCbCr and differ
  // by about 80 levels on average.
  for (const name of ["rgb_adobe_transform0", "ycbcr", "gray"]) {
    const { encoded, expected, info } = await fixture(name);
    const parser = new JpegDecoder();
    parser.parse(encoded);
    const [height, width, numComponents = 1] = info.shape;
    expect([name, parser.width, parser.height, parser.numComponents]).toEqual([
      name,
      width,
      height,
      numComponents,
    ]);
    const decoded = parser.getData(width, height, /*forceRGBOutput=*/ false);
    let total = 0;
    for (let i = 0; i < expected.length; ++i) {
      total += Math.abs(decoded[i] - expected[i]);
    }
    expect([name, total / expected.length < 3]).toEqual([name, true]);
  }
});
