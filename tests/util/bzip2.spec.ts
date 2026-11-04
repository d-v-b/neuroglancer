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
import { decodeBzip2 } from "#src/util/bzip2.js";

// Python's bz2.compress of the texts below
const SMALL =
  "QlpoOTFBWSZTWQ1jjg4AABwfgEAAABABIAwAIwoRACAAIr/VQAZCAaANLMtpZaccXSlVtdCFVkvi7kinChIBrHHBwA==";
const RUNS =
  "QlpoOTFBWSZTWUwX/psAAAn/////////////////////////////////////////////wAIcAAEmAAmAAJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkwAEwABMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEmAAmAAJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFVSpoEwAAJgEwaCYAAJgmTAAAJgAEaYBGRgAJgDTQAAAAAAACYAAABNGTAATE0+EEB84QQIhBNYQQRIiZFCKn0EWIuRgjJGiNkcI6R4j5ICQkiJGSQkpJiTn0koJSSolZLCWkuJefUTAmJMiZk0IU/ObEKTcnB9ZOSdE7J4T0nxPygFBKEUMohRSjFHKQUk+wpRSymFNKcfaU8qB9xUSpFTKoVUqxVysFZK0VsrhXSvFfLAWEsRYyyH3llLMWctBaS1FrLYW0txby4FxLkfgfiXM/IuhdS7F3LwXkvReyqwXuHhH6EQgXwvp+p+xfi/mAMCYIwZhDCmGMOYgxJij9zFmMMaY4x5kDImSMmQxlCGhyWmVMsZczBmTNGbM4Z0zxnzQGhNEaM0hpTTGnNQak1RqzWGtNca82BsTZGzNobU2xtzcG5N0bs3hvTfG/OAcE4RwziHFP4OMcc5ByTlHLOYc05xzzoHROkdM6h1TrHXOwdk7R2zuHdO8d8/k8B/R/Z4TxH+HjPIeU8x5z0HpPUes9h7T3HvP9PgWmCAwHxMGfI/4+Z/4u5IpwoSCYL/02";
const TWO =
  "QlpoOTFBWSZTWQ1jjg4AABwfgEAAABABIAwAIwoRACAAIr/VQAZCAaANLMtpZaccXSlVtdCFVkvi7kinChIBrHHBwEJaaDkxQVkmU1kmigI0AAACgYAOAYgAIAAiGGgwBwKYXckU4UJAmigI0A==";
const BLOCKS =
  "QlpoMTFBWSZTWXTTO0kAAMf////////////////////////////////////////////wUAXeAAAAAAACAAAAAAAAAAAAAAAAAAAAANNAAAAAAAAAAAAAAAAAAAANCAAAAAAAAAAAAAAAAAAAAANNAAAAAAAAAAAAAAAAAAAANCAAAAAAAAAAAAAAAAAAAAANNAAAAAAAAAAAAAAAAAAAANCAAAAAAAAAAAAAAAAAAAAANNAAAAAAAAAAAAAAAAAAAANAUqqoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANNAABkaYQpGDoWBwwIsNCLDgiw8IsQCLEQixIIsTCLFAixUIsWCLFwixgIsZCLGgixsIscCLHQix4IsfCLIAiyEIsiCLIwiyQIslCLJgiycIsoCLKQiyoIsrCLLAiy0IsuCLLwizAIsxCLMgizMIs0CLNQizYIs3CLOAizkIs6CLOwizwIs9CLPgiz8ItACLQQi0IItDCLRAi0UItGCLRwi0gItJCLSgi0sItMCLTQi04ItPCLUAi1EItSCLUwi1QItVCLVgi1cItYCLWQi1oItbCLXAi10IteCLXwi2AIthCLYgi2MItkCLZQi2YItnCLaAi2kItqCLawi2wIttCLbgi28ItwCLcQi3IItzCLdAi3UIt2CLdwi3gIt5CLegi3sIt8CLfQi34It/CLgAi4EIuCCLgwi4QIuFCLhgi4cIuICLiQi4oIuLCLjAi40IuOCLjwi5AIuRCLkgi5MIuUCLlQi5YIuXCLmAi5kIuaCLmwi5wIudCLngi58IugCLoQi6IIujCLpAi6UIumCLpwi6gIupCLqgi6sIusCLrQi64IuvCLsAi7EIuyCLswi7QIu1CLtgi7cIu4CLuQi7oIu7CLvAi70Iu+CLvwi8AIvBCLwgi8MIvECLxQi8YIvHCLyAi8kIvKCLywi8wIvNCLzgi88IvQCL0Qi9IIvTCL1Ai9UIvWCL1wi9gIvZCL2gi9sIvcCL3Qi94IvfCL4Ai+EIviCL4wi+QIvlCL5gi+cIvoCL6Qi+oIvrCLABF9gRYEIsBVC+2qF91UL76oX4VQvxqhflVC/OqF+lUL9aoX7VQv3qhfxVC/mqF/VUL+6oX+VQsFVCwdULBFI/0pH/FIwhSP/MUFZJlNZCq4MhACyFv//////////////////////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";

const bytes = (base64: string) =>
  Uint8Array.from(Buffer.from(base64, "base64"));
const text = (data: Uint8Array) => Buffer.from(data).toString("latin1");

test("decodes runs, several blocks and several streams", () => {
  const small = "refkv: a FITS frame ".repeat(3);
  const runs =
    "\0".repeat(5000) +
    "x".repeat(300) +
    String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)).repeat(4);
  const period = String.fromCharCode(
    ...Array.from({ length: 1000 }, (_, i) => i % 251),
  );
  expect(text(decodeBzip2(bytes(SMALL)))).toEqual(small);
  expect(text(decodeBzip2(bytes(RUNS)))).toEqual(runs);
  expect(text(decodeBzip2(bytes(TWO)))).toEqual(`${small}second`);
  expect(text(decodeBzip2(bytes(BLOCKS)))).toEqual(period.repeat(300));
});

test("rejects bytes that are not a stream", () => {
  expect(() => decodeBzip2(Uint8Array.from([1, 2, 3, 4]))).toThrow(
    "bzip2: not a stream",
  );
});

test("rejects a stream cut short", () => {
  expect(() => decodeBzip2(bytes(SMALL).subarray(0, 30))).toThrow(
    "bzip2: the stream ends early",
  );
});

test("rejects a stream with a block's CRC changed", () => {
  const changed = bytes(SMALL);
  changed[10] ^= 1; // the block's CRC follows the header and the block's magic
  expect(() => decodeBzip2(changed)).toThrow("bzip2: a block's CRC differs");
});

test("rejects a randomized block", () => {
  const changed = bytes(SMALL);
  changed[14] |= 0x80; // the bit after the CRC
  expect(() => decodeBzip2(changed)).toThrow("bzip2: a randomized block");
});

test("rejects bytes after the last stream", () => {
  const all = bytes(SMALL);
  const after = new Uint8Array(all.length + 4);
  after.set(all);
  expect(() => decodeBzip2(after)).toThrow("bzip2: not a stream");
});
