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
import { decodePackBits } from "#src/datasource/zarr/codec/packbits/decode.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Written by imagecodecs 2026.8.16's `packbits_encode`, or given by hand, with what
// its `packbits_decode` returns.
const CASES = [
  {
    name: "empty",
    encoded: "",
    expected: "",
  },
  {
    name: "runs and literals",
    encoded: "/GEEYmNkZWb8Zw==",
    expected: "YWFhYWFiY2RlZmdnZ2dn",
  },
  {
    name: "one byte",
    encoded: "AHg=",
    expected: "eA==",
  },
  {
    name: "long run",
    encoded: "gXqBeoF6jXo=",
    expected:
      "enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6eno=",
  },
  {
    name: "long literal",
    encoded:
      "f7Wn90aDsswNfqUL7suYAvs4jpNHlw7QCgHa5vJJxjcMvWi3MztVnJGBMcOQXIaPvsOLW2H/u1kuHRXgzjpC7VFwW6cgIsnYYST9ivNbMvTp/22Uuv2KaJpYhPAsTKhq8PKoWLHm/971sOfDF0gikRpVVXCOZCsGszwOPRpWSGR+f/J6LwtDyqSec12HZMQPM/pA6+iwjJehfGQxG7rfjsS1o6dFq/bskM+KIXCXgtOMIR4uBuE+ZiPZk+6jiRUbacR+4woZxQm58Yz2KyTgoxoE6fxX9gGQjW+XiVDMrUSMNn6dugEDgGTAkLQg8li1kQVKxsmnBBpfI7mfIumMU77nK8vJDyewzJvWj5uwluhHQzJHyPaAEzA+W9W+fiyzzqviB/UWEA6Ysw7v1h+q",
    expected:
      "taf3RoOyzA1+pQvuy5gC+ziOk0eXDtAKAdrm8knGNwy9aLczO1WckYExw5Bcho++w4tbYf+7WS4dFeDOOkLtUXBbpyAiydhhJP2K81sy9On/bZS6/YpomliE8CxMqGrw8qhYseb/3vWw58MXSCKRGlVVcI5kKwazPA49GlZIZH7yei8LQ8qknnNdh2TEDzP6QOvosIyXoXxkMRu6347EtaOnRav27JDPiiFwl4LTjCEeLgbhPmYj2ZPuo4kVG2nEfuMKGcUJufGM9isk4KMaBOn8V/YBkI1vl4lQzK1EjDZ+nboBA4BkwJC0IPJYtZEFSsbJpwQaXyO5nyLpjFO+58vJDyewzJvWj5uwluhHQzJHyPaAEzA+W9W+fiyzzqviB/UWEA6Ysw7v1h+q",
  },
  {
    name: "mixed",
    encoded:
      "AAH+AAYBAgAAAgAB/QIAAP8C/gEFAAIBAgIB/gD/Af8ABQEAAAEAAf4CAQAB/gIEAQICAQD9Av8B/wADAgEBAv8BAgIAAv4BAAD/Af8A/gH/AgQBAgAAAv0BBAIAAgIA/wIDAQAAAf8CCgACAQIBAAECAgAB/wL/AQgAAQIAAgAAAgH/AP4CAAD+Av8BCAACAAEBAgEAAv8ACgECAAIAAgACAQEC/wEIAAEAAQIAAgIB/wANAgEAAgACAAEBAAECAAL/AP8CFAABAAIBAAEAAQIBAAEAAQACAAEBAv8A/gIBAAL9AP4B/gL/AP8C/wAFAQIAAgIA/QEBAAH9Av4ACwIBAAIBAgEBAgACAP8C/gEFAgECAQEC/gAAAf8A/gL/AQECAf4ABQEAAAECAP8CAAH/Av4A/wEAAv8A/gL/AP8B/gAFAQIAAQAB/wD+AgQAAgIBAvwB/QAAAf4CCAABAgEBAgECAP8C/wAGAgAAAQIBAv8A/gL/AAkBAAEAAgEAAQEA/wIBAQL/AP4CAAA=",
    expected:
      "AQAAAAECAAACAAECAgICAAICAQEBAAIBAgIBAAAAAQEAAAEAAAEAAQICAgABAgICAQICAQACAgICAQEAAAIBAQIBAQIAAgEBAQABAQAAAQEBAgIBAgAAAgEBAQECAAICAAICAQAAAQICAAIBAgEAAQICAAECAgEBAAECAAIAAAIBAAACAgIAAgICAQEAAgABAQIBAAIAAAECAAIAAgACAQECAQEAAQABAgACAgEAAAIBAAIAAgABAQABAgACAAACAgABAAIBAAEAAQIBAAEAAQACAAEBAgAAAgICAAIAAAAAAQEBAgICAAACAgAAAQIAAgIAAQEBAQABAgICAgAAAAIBAAIBAgEBAgACAAICAQEBAgECAQECAAAAAQAAAgICAQECAQAAAAEAAAECAAICAQICAAAAAQECAAACAgIAAAEBAAAAAQIAAQABAAACAgIAAgIBAgEBAQEBAAAAAAECAgIAAQIBAQIBAgACAgAAAgAAAQIBAgAAAgICAAABAAEAAgEAAQEAAgIBAgAAAgICAA==",
  },
  {
    name: "the TIFF 6.0 example, with no-ops",
    encoded: "/qoCgAAq/aoDgAAqIveq",
    expected: "qqqqgAAqqqqqqoAAKiKqqqqqqqqqqqqq",
  },
  {
    name: "the code -128 is a no-op",
    encoded: "gP5BgA==",
    expected: "QUFB",
  },
  {
    name: "a final lone 0 is ignored",
    encoded: "/kEA",
    expected: "QUFB",
  },
];

test("decodes as imagecodecs does, with or without a size hint", () => {
  for (const { encoded, expected } of CASES) {
    const bytes = fromBase64(expected);
    const stream = fromBase64(encoded);
    expect(decodePackBits(stream)).toEqual(bytes);
    expect(decodePackBits(stream, bytes.length)).toEqual(bytes);
    // A hint that is too small only makes the output grow.
    expect(decodePackBits(stream, 1)).toEqual(bytes);
  }
});

test("rejects a literal that overruns the stream", () => {
  expect(() => decodePackBits(Uint8Array.of(0x01, 0x41))).toThrow(
    /a literal of 2 bytes at offset 0 overruns the stream of 2 bytes/,
  );
});

test("rejects a run with no byte to repeat", () => {
  expect(() => decodePackBits(Uint8Array.of(0xfe))).toThrow(
    /a run at offset 0 has no byte to repeat/,
  );
});
