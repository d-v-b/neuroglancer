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

import { describe, expect, test } from "vitest";
import { decodeLosslessJpeg } from "#src/util/ljpeg.js";

interface Case {
  name: string;
  // What wrote the stream: imagecodecs' `jpeg8_encode` (libjpeg-turbo, with
  // `lossless=True`) or `ljpeg_encode` (liblj92), or libjpeg-turbo's `cjpeg`,
  // which also writes point transforms and restart intervals.
  encoder: string;
  height: number;
  width: number;
  numComponents: number;
  outputBits: 8 | 16;
  encoded: string;
  // The samples imagecodecs' `jpeg8_decode` returns, [height, width,
  // components] little-endian; `jpegsof3_decode` and `ljpeg_decode` return
  // the same for every stream without a point transform or restart interval.
  expected: string;
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// The streams below are 13 x 9 images of a gradient plus noise, written by
// a script that also checked each decodes, in imagecodecs, to the image
// it encoded (shifted by the point transform, if any).
// imagecodecs 2026.10.10
const CASES: Case[] = [
  {
    name: "gray 8-bit, predictor 1",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 8,
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/wwALCAAJAA0BAREA/8QAGwABAQEAAwEBAAAAAAAAAAAABgUEAgMHAQj/2gAI" +
      "AQEAAQAA/P8A33K4X76FRE7G57pWk6lvid5en8NsxAanIxlbMjaeeXdLESg+YPRxNqz3RvUcVjzt7TuKBq4pVfld" +
      "+LOgW5kcK5VpHIfoWRLB6ZaivR3jVFgvtZzrlXOwwidyq8Fd7tK8WmuH89+JSfZq3d//2Q==",
    expected:
      "AAcjOgABQ1QeKmFAOi0BFTAuDA5dWmdUdE8cPwwiGTxwLUpThE5uGwxTHTdQVj2OgZlVki5KckBuQ1iXbXxvZ4db" +
      "UnVYdImbeFyek7iaVUFpgJGgbpauhpPGtXGGfq6ganiiwIbBz9igbJKujoalipza0eft",
  },
  {
    name: "gray 16-bit, predictor 7, a difference of 32768",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 16,
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/wwALEAAJAA0BAREA/8QAHgAAAgICAwEBAAAAAAAAAAAADQ4LDAkKCA8QAQf/" +
      "2gAIAQEABwAA972z+QZ2i8DywflNpp0yMX/Fc6PfO9ykI1s8dCsDg5nnZXhgAB/qKXGXNC+DfFZ9XjDHo/6s3trI" +
      "JNH2UJisJYQNJQXKBjPc4pKxwHKbhWgI/E3LuLMDqMnHqCcdAmiG8gyMFYcnbLIlZdFqAd4tKCzb8c8xV87h8m6z" +
      "HWhpbHyQJMqtBpVPW+ssrNSLaoQQnklvXoaWkeumZIMsusTX2MtQUIbjTgOa5GvW2aFPTsS+AaWlvN4ZNYQRs2sp" +
      "WJS0HNd0KM+wniRfvHrjnNb0xmkwquoDe4Gj/wD/2Q==",
    expected:
      "AAAAgAAAfwLmEqI7OSMfC2wmnkNdXLVb03j//yg3AADNKDIXeRf2RIIt90nANusznW0pWYkvTTVpU2MtoCJ5TMls" +
      "IHYxdPxqs1c9X8hHvRW9KGow7UqiS61hM3mOfnV8LZSNYmebZ6MBKadEoFPNZO1r4D/9ZcZMKJw2Yt99lqk9kRBg" +
      "OFeme25sTHeabSBwp4alhhmkVZqBlmO+YEgnYs9sB5YHdmKLG2TqqqCQxpsWgH+5+bpEY4uOFYDiXgtzPX1Rdgyf" +
      "JH75reHD+r8OvFJtqKkSf3KxnZYqmAu5hdcIzhXEPKEL4Evo",
  },
  {
    name: "gray 12-bit, predictor 4",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 16,
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/wwALDAAJAA0BAREA/8QAHAAAAwEAAwEBAAAAAAAAAAAACAkKCwAGBwUC/9oA" +
      "CAEBAAQAAMalKvOcupMZb8wRaOvPNtQdHd1m0ApMP/6VrFSVLkXy8QMoCLlLHbevaaKp84IhQZf8YRvgHe/JpLFp" +
      "XrGl1eqX0ZekKohVBgThXA1bYzs5GlLaIhArMtL1uy2ztBV2Ubs3+kGuvOJaK8qgBO/hB8prVrTDfVG/DJrVSkUV" +
      "hH04h3JfugvMATZc5pt5rDC/CJPqF8+VC2nRMt8205VWWK7aruXtsZBdU//Z",
    expected:
      "qgEAAAAAAAAAAKkDbwRPA9IAhgE1AygEkgXlACkAAwBDA+cDkABoAaADtQPFBjMFGAWPBecC5AIXAYQEBwWBBgEG" +
      "vANWBIAG7AaTB+kI6wHHBS8B/wExB3IHaAT4A1AFRgQ3CWcIZgirAkoEMwO5BokFkwMuBQIIawcNB9EGXAaICeYF" +
      "kAUrCI8IHwWsBzMIkQY/B6sIbwpyCCcL3wb1BEYGCwmFCfII3gXmCd0HdAtcDC4Kag1xCIoG5gmsB5MGnAljC8QK" +
      "xgnmDA0L9goYCogGiQl8CjAIZQoZDKYIvQl6CxYMoAsLDAIL",
  },
  {
    name: "gray 2-bit, predictor 6",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 8,
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/wwALAgAJAA0BAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAQAC/9oACAEBAAYA" +
      "AChoqqLUS1qNNSm7LCNCLMaUaplDWhko1oho1o3h1jVOjNQbHRnV/9k=",
    expected:
      "AQEBAAEBAQAAAAAAAAEAAAEBAAAAAQAAAgEAAQEBAQABAQACAQABAAABAAEAAQAAAQEBAQEAAAECAQAAAAEBAQIB" +
      "AQEAAAICAAEBAgABAQACAgACAQABAQEBAwACAAICAAIAAQIDAQEAAgABAAICAQMCAQIB",
  },
  {
    name: "RGB 8-bit, predictor 5",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 3,
    outputBits: 8,
    encoded:
      "/9j/7gAOQWRvYmUAZAAAAAAA/8MAEQgACQANA1IRAEcRAEIRAP/EABwAAAMBAQEBAQEAAAAAAAAAAAQFBgcDAgEA" +
      "CP/aAAwDUgBHAEIABQAAw7FP5/ZKiJ5/8rqFooASFdtDYjrE9rb6JDSWaNGruhAPK0xvMB8FXpdZWbHsvUJqA+q7" +
      "Eyk1pJB0W4lDUWmWphMYOV0axZBCz3a1Gkcc6gZXTtFXZ54s3ntN1x+zpb6HD6bSKGlXVFDrfuZjebht8UfbKoG9" +
      "zdV6buJDhME3xuoTQmd29otVJqVB7b8PkjQj6KRf1DfnI89GsdCyhktavpfQ/nwXOjIsmfP0sIdfsOo80UjMcDUr" +
      "hq+a2XGgyzzL6NQ1QcEOxoFL0vr+N0ow9MsjYDidph7TvRdMxzPwpk6+kbCcNGRAJCuYFa68GXy6TS6DOtnVt8zB" +
      "ZBX+itRFNw1pNXop7K693Vwlj6Oj2T1t09QIhVtIedB1FWF1r4Y+eqZFkwLOLna/s4zuvQu1mhvC4NNKaJStIt1b" +
      "aLn+Wwnag/apYaKhzsFoXRd//9k=",
    expected:
      "DxUAIQAIAB8HLkAbFzEAITdDMi8wGmRnXis6Ez9PLmBAPWqMVEOACAACACc5ADwoADNSA1VKES1GYjFKImM6USlv" +
      "YD+COkeERWF2WFVdCzUqT0IAESJFVgwXVFAvXiMyJlhZRDlFX4VVWnZNb5upd4JwfJR5Ch4rXkwNQhhZZiRaNj8/" +
      "RGZNeFtVQ4J/PpNuYGxtgXeaV4t1npy4MjUnLkheUXAtdWRCe0l3gVt0VmFERFRojE9XjZynmYSPXYeJZqe/UEpZ" +
      "SHMhV19OioNMUG13c2CSaGh6bKuYn498bXaegbahd77Af4CPTTQteGwndFuDcF5nXU9tm2J3oaRad6uqbrO2i6V4" +
      "goi4wqG8sLq4cYtPZVN7fnVurXhuc4KOqI+VbaWQjnm2ys6oy8y4jcy31qrL3cHXfGl+fGVQt1hku5yAqWV3mK+f" +
      "joa21LWJoKSIwKPk0ejFscnjv/bw",
  },
  {
    name: "RGB 10-bit, predictor 6",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 3,
    outputBits: 16,
    encoded:
      "/9j/7gAOQWRvYmUAZAAAAAAA/8MAEQoACQANA1IRAEcRAEIRAP/EAB4AAAMBAQEBAAMBAAAAAAAAAAYHCAkFBAMA" +
      "AgoB/9oADANSAEcAQgAGAAD+f/8An/yJJ3eyemB+sdDFfdLsSUqAOmD9q1IrheUQaXsKWmrCaBmNUNaU3OQksHA/" +
      "PwkZvqiFdA9G1k1H2jPDZzqpvNOWv80AtDQzPWbcr/gwdFeZotGSK85LeU2U76qnfSQOhYxaWk86FM6khJULwoR9" +
      "XR4UJm5K8nXFZehrBhTLyrS6wF81E8hdHRyvEM16x44dVr7lF2/XX3myZm4LUY65ULQqy7R0+FutPhha2nKH+CbI" +
      "4TTJAzm4TLxstMMJD81uOcW7CHZMNiEbGuSWgeymiq3m1L9NatPgfbj2uuqeb1Os/nj8rzDX7b8NqWfHJvG3OgfU" +
      "XlW1kM7auuaYI3753SjGeOl/VCoSmNWswg/SweH6HrpVeJ/1nghjAiZNP9xi5I+AgvkbctIWIENJ/I2fjsa7dtal" +
      "XMiXinSkX0o015eec53KWcBd59uuMaQprSbSnloii7/9kNxHYhI7Hcez+vHKQL5NftHlbEdi58ef41Ws4T6LW1fb" +
      "zDuNrOjmoyy2ZLkgxtr/AKOfDjSj1FUOXqlw0x+lk0W7FTl8YNz4gsz/AP/Z",
    expected:
      "AAAAAIoAJwBvANMAOgAzAN4AGAAAAI4AAQFsACEAVgAuAFEB0wDbAOMAjACYAGsBwACOAUABkwE7AWYBmgCBAQcC" +
      "TgEcAnoBIQHNAdoBfAAAAK4AsgB5AAcAOgAAAAUBygA6ABwB5wB7ADYBswDQAK8AXAArAZIBIAHMAbgAeADYAN8A" +
      "sAH1ASIBvgERAXAB2AEJAiAC0wBgAjcCIwF6AD8APwGNAAAA0gAxAXYAPwFIAPgARQEjAZQBZgGeAcYBpwAXAfoA" +
      "nQARAU4BAQGHAWsBCQEJARUCmAFbAagBGQLNAcIBEAIfAsQCqgDRAPAA6gCHAAUBIgGAAGUBbAFsAV0BqACSAJ0B" +
      "owHAAR8B8gDzAHEBkwE9AmABkgGaAaQBJwJLArkBIAKYAZ0BcQGFAdwBCgJXAvcCZwAqAUMBlQDXAG0BLAGLAQsB" +
      "zgECAUkBCQHlASEBCQH8AOQBOQKmAYsBpAEuAoABUAHlAZUBDAJYAogCzQE8AmIC5AEmAi4CIwL/AYICJgGFATUB" +
      "yAHTAaAA/AFAAZMAPgEhAvgAmwH7AGUBAAJtAWcB7AH9AYcBEQKfAu8BtQIyApcB0QHiATcC+wEhAjYCvAL8ASAC" +
      "BAMUA2wDZQGbAaUBbgEOAvoAGAL8AdwAkQERAQ0B5AFsAUsBiQI1Ah4C+QGzAmACpQF5ApYCWgI6AsQC7QLMAlcC" +
      "+gI0Am8CEwMtA3EDGwOgAogDSgLHAYYBnAEgAVUBYQEVAqMBWwJGAlwB0gGRAnECjALjAdUBvgKuAqcCdQKzAjkC" +
      "fwK8ArUCvgKoAlECHwLYAo8CagN4AnkDQAPwAkADXgHYAdwBhQKGAcMBuAKeAkIC9AIXAnYCagLWAUACDwIEA9gC" +
      "eAIlA3oCZgKZAv8BbANHAmYCZQNxAvIC/QIoA4kCmALQAtID0QLiAtQC",
  },
  {
    name: "2 components 8-bit, predictor 2",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 2,
    outputBits: 8,
    encoded:
      "/9j/wwAOCAAJAA0CABEAAREA/8QAGwAAAgMBAQEAAAAAAAAAAAAABQYDBAcCAQD/2gAKAgAAAQACAADJspEqtwwZ" +
      "jFFi8Vwyoe1yZxilQXlst8rCtL8cDpltjYVYePh0RzZmYmmEPZDCsI0uzbZKOmuFLj52cylU/wBPkrwyOmwWJy+t" +
      "kNHJE4FluIipWoeZ0RDKpizRKq2fhRB9fvTkHHRG0s6aVf479GOZNkNlR7cdMvr0PzwqPmWZy0kp5meIizEqGSN9" +
      "9HcuCj1pOkLJaduXlJ0Z1Uh3feeYtBYW+5preSJJXBcm2ExGj3lsXZ7ONiiZf7TB0Lou5B00K+sNYufQmI5o5UsM" +
      "5raOHGBUI4xFPYWG8zf/2Q==",
    expected:
      "JyoRAB0YNhQhKjglRD4VPw1SKXQuNmdicmAAARYAOQADH0RLDxU0OFlyM3g8QT43a3pJSUsKISQrTTMSQUtFSEgu" +
      "eHRvfXRlcpdzgWCkW1EzNyQnYSMsUG84YXI8iTxXZnpJV1lqf4RpWENoaFR3V3ZfbDtiX2+cYHJ7and0cqe5dCZt" +
      "M25CW41be32Sc111kXF5g4qnZnKiebu9bkdJdXA6YI+iU6J2bK6PbLqkubOzobSLhrqFWnWIWYFua45cpZKYgKir" +
      "xMS7n6XYxL/IyV6FYY+bo4qyo3KSkI/HkJiqh9fBudm+4Nbv",
  },
  {
    name: "4 components 8-bit, predictor 3",
    encoder: "jpeg8_encode",
    height: 9,
    width: 13,
    numComponents: 4,
    outputBits: 8,
    encoded:
      "/9j/wwAUCAAJAA0EABEAAREAAhEAAxEA/8QAHAAAAgMBAQEBAAAAAAAAAAAABQYDBAcCAAEI/9oADgQAAAEAAgAD" +
      "AAMAAMS/P/5/wMZ421+99tvt4mmIXJPTCGhLiYx569PxPWaZeFSMpBrsu55+RULjJeMuBa0UUa573cHjcZJ9CW/P" +
      "VkalWAGrOhyreZSDLqLk1WGgMuBkto0Qa9gTk3J9o1krK1OiLctlmz1vR2rQ290cnyTS2XVBLK8OOnutITYfYuzD" +
      "mmib14w7NGrsVQLqDO6sC+1NQ8CQZqglMqzNqtqzUqN1Z85cl1maAxfRJFImcJMewslEcZPmtYfmCoggxlLRir6O" +
      "YKHWkv8AxoT+7+e21z2pj+XRHemgGpYMpb+UHs1HmU8eK6NZT7F7TXOmVVxTCdc2kzphv4fPlKudil5/UpWsiAvP" +
      "V2d80nihOcW3e08+VmYhpOg6ZqZfoRa03QHWgwOa5obUYd3bTtWVSbDobTAQftQKKh6BX05kMIilXRyummIXJ3Zy" +
      "rdp2ny2iospQg6i0RacCbNBMWPy+azB8yXe7S9xqWpuonU3lpYNAXXq/pJjTNbbPh/Rwr8yQLKuG+vS8yiLDn1o9" +
      "3Vk1dbmNZ0W2aiUmE7cWIG937Pk5aK46RfYyPOjNelMB24zeUn5Z+aXoc2gkOHtm0OZlOMy/1omonv/Z",
    expected:
      "EwAABAAAGy8AABw6PQ4vBwAMQlMQTh8gMwxZXkZlTXVAOGY+Wjt9cRpMTn0+WmetVGR7fwseAAcMABsAEj0AOgA6" +
      "JSgIFhBdNCg4YTVeRHFlNmGGLUI0QWh8VHk8V4NvOXSnkkOEm3MXKRYzCylHMU8vTzJOQUtfVCRKYDllRVAeMHVc" +
      "OHZ3P09Eb55jaotjXWKkoHF3Y5ljZImiPR4AAA0vQwphUxxfRmtNZCxnc0ZraE4zTIFXc39UZ0tRlZGXjWRkYEdX" +
      "fqlyn5PAYnms2DpgPzc9WS0zd1JCF0pWaUBwRGYwa3tjbF1mU1Fqlp18T1x1mISJpm94hYGTcHDKxHG+stQwHCoW" +
      "eTNEYk46O22EWX5gR0dwXEx7cGlrUol8pqefpIGYhoacnKqJpLyDsqKduMm+xqDXUV9TD0BaeipOUT06nF5TMldR" +
      "RnWUX2qOg6KFl7mhjoa7k7OVepqBynfMva+dwpnRp53j4XB4akpbPlBhk49kfYd6XXp6mGJ7b52hoZN+sXTBxn5x" +
      "kYiPwJq4nJ2tnMjXzZqb3cCc3tyKcz1rjYRDQ4p1U4CmlFZau3VedouWqKa5vb6tuX6EspvFybSXyZ+91d7fo9K4" +
      "7rfP3uz7",
  },
  {
    name: "RGB 8-bit, predictor 1, point transform 2, restart every 2 rows, COM and APP15",
    encoder: "cjpeg",
    height: 9,
    width: 13,
    numComponents: 3,
    outputBits: 8,
    encoded:
      "/9j//gALYSBjb21tZW50/+8AD0FQUDE1IHBheWxvYWT/7gAOQWRvYmUAZAAAAAAA/8MAEQgACQANA1IRAEcRAEIR" +
      "AP/EABoAAAMBAQEBAAAAAAAAAAAAAAIDBAUBAAb/3QAEABr/2gAMA1IARwBCAAEAAvn/AJ/DpZSxa4qJvO0KpnHR" +
      "Ixj+FWaUuqDqdAq4K/d53jtCvPCP0r9LlKWeooqXaFef3OYu8rYmn//Q+fzsfQlnlos0ZER6enWEjTdHVXoJkXNS" +
      "/SoiCNzNbRgS6yqKs3JZR6U26zZpIKH6Vy84dLSQBNmJR//RnggFqeK91z5mc1D0O+Tnl62PwU8ps1OFP1lClJSd" +
      "mhoCwEQxFRqaCJV1P4p9b5CutHPYPfaf/9JapZnJCJtXLAYFlC/UdcLh9yWu3udNq6lQRrax5xzTX2uGJPmidtz0" +
      "JBlU1NFNUdI9Bvlwf//TWpdaHctIimjKvSdL0tCUZ6rGMCyIukCG9L//2Q==",
    expected:
      "AAAQJBA0NAAkACAAADhAKBRYNDQsRERIQEx0TDRcZFxQaESQcHBULAAUKAQQQEQ8ADgMABAoSAxMMBxMUDx0QHBo" +
      "bDBsKEBcZEiQMFycADwgQBQAGDQwXAgULFRgWEg0bFRMPHx4fGRMbEBwiIiQVHxgbIy4RAAIXDAwKFw8QERMYEQk" +
      "bFh8gDRQRFRsjIxcSISkkGiYmHx0oGiAYEREWFgsVEQsWFxINGxEhHiEiHhsSIBsfFBscHRolKS4kKyYlLy4TDAs" +
      "NDxcdHxUhHA4TDxAbIyAUGRweIBsZJyYgHCguKSYeLSQfLTccGxYTIRAQFBUaEyEXFx4jHxojJxspJSEnJSAdMC0" +
      "eHyQzMy4wJyohHx0kExQbIiEhIBQbIBkZIyYnKh8hJyMrHiwzJzYnMDQoLTkoKSocGxwnFCImISQoIxscJSYuKxw" +
      "vLSwlKyQvNygzNDQmNjUoMy4tNDA",
  },
  {
    name: "gray 16-bit, predictor 7, point transform 3, restart every row",
    encoder: "cjpeg",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 16,
    encoded:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/wwALEAAJAA0BAREA/8QAHQAAAwACAwEBAAAAAAAAAAAACQoLCAwFBgcABP/d" +
      "AAQADf/aAAgBAQAHAAPS8mvJKH1mcmivCdewOqzp95Rvg//Q1Adcar9CypAnfq4RH7jsMd6qpmPn/9GFsNdong4u" +
      "Oyq9eit7NsFVDcebvf8A/9KTF4PLZeopWiOU/GHs+kPh9lq5N/8A/9OB8FK14FpD1n+k1lwnRhHmCee0p//UARMy" +
      "eR8+CQ9emBRrUWP1m4GalX//1Q6fvYwLvCJ2HKOG5wCEvNGDI7oP/9ZXXKVnMrAJ6c3guHybWw+SajvVef/XfwY5" +
      "wOys5Q965rqsu5xijV3xWz//2Q==",
    expected:
      "mBd4LQAAAAA4M9g8oCgAEOhQKDwIJCApKEdAIHgOaDoAAAgkADOAXoAnaGCoJvhDkG1gZbhFeDzAUOBPcBsYZhBl" +
      "8C+gfVBwEFKwSYhlGFNYTygmaEPQaEhdSEdoPQiN0FSYcwiJCHD4QZA0cGpIXTg/MFMAeMB9CGUoXjBkaHMIqEhw" +
      "4EloZmBkqFYgdChagH04Zgh26HwgcHiVqHMgdKCFWJGoVTiZWGcYgShy8H3woGClcKOwa9hwcIQwj3CAoKfQo8id" +
      "oISAyNibyKqQ1oCfSLHAqSCvwK84v6itUMjIn4i42Nu43SDJ",
  },
  {
    name: "gray 16-bit, liblj92",
    encoder: "ljpeg_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 16,
    encoded:
      "/9j/xAAbAAEAAwEBAQEAAAAAAAAAAAANDg8MCgsAEP/DAAsQAAkADQEAEQD/2gAIAQAABgAA/fSZ6NJtyf7xSAHD" +
      "DuWxpOA4aTOEGF/mluGLE5KG8RkKwHtpysaTNm4jGRoJk0lZT7FBOzxytaY8fRXsCV7k7BnI4d0dVj/c1KILXack" +
      "x0+efuKfzar0DndBLz+A40qsDi57MgH/AO2DaMzJdNqrTha7G591Q9inT9Ak/FORm5uI16i4hE5mAYajmzdJ3H/w" +
      "s/PeJqU2PD28GVBSoBPJHzn74uRdEP15E+ydD7An3YHmzVFg+EaSLc7or/L7Jbvm8pbTRw5kUb5xKK+7eQZJmYVX" +
      "BXO4+XUJNZPZmm9exGmTjcJBOOj/2Q==",
    expected:
      "AAAAAHomoRPwIXopfTm5BUYzBx07Ob9s11IAAFsaAACMOalQ4FnuQYZdeTn8LMFSjFPPbH1KrRPFSxUVjS2wWSEy" +
      "xlxMUWxcloeFgwCMnjQmYJpm+yR4MeVAZlwEeotjypSMZTCdBIdqU4wwjlUObtR7voDXj9hO34zXeBCSwnXqZSQt" +
      "nn+if6JT/2RuWwlaLJ0GlKpn8nhcnr7BMItKT4F3tUxYXyVoTIOlgb+oSZnDlLrLVLrZgY6MbHAYpghiVoFce6B0" +
      "4s8UiTWvfdQU0JWftmEKjhNtFIF9vxyEmba2jOeruefEuaC/",
  },
  {
    name: "gray 8-bit, liblj92",
    encoder: "ljpeg_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 8,
    encoded:
      "/9j/xAAbAAEAAgMBAQAAAAAAAAAAAAAFBgMEBwIAAf/DAAsIAAkADQEAEQD/2gAIAQAABgAA0TizayC25FkqwUsD" +
      "YqrWtxdz4k8kOu5Zkta0UClS8Il3jNrIReycA7ESRmxCUx5hauw89z5HZdjZtcMmMumkWgc3pyb4TJr5zpzuWUpk" +
      "p1FSXj5GN458WmeJMkJhRK1jpZGFJBhvuweUynORVxxJD8tkgP/Z",
    expected:
      "CgA2OgAFDRE7LT8wdR8kAAVMIFZWGUhVVTwzESAsKDxkSmmASVNzFUZMU3FJfIeFWkuXpDFTMHN4WYBWnZSclmdo" +
      "aEODSmiOllp1uJ5+UnBCbWRyknG4s67MioSZhoicpJqhqb/U06yhb5q7w8jBrJPV3t3V",
  },
  {
    name: "gray 12-bit, liblj92",
    encoder: "ljpeg_encode",
    height: 9,
    width: 13,
    numComponents: 1,
    outputBits: 16,
    encoded:
      "/9j/xAAbAAEAAgMBAQAAAAAAAAAAAAAJCgcICwYEBf/DAAsMAAkADQEAEQD/2gAIAQAABgAA1Dnf9Xk1DenbI5DG" +
      "+V8rYiJkSlAZtRK5Fmxj1e8oycRR0lagu5jrJ6QknH42LspLDfAHY1xDn94eZJ1FjWjHjk1dQitB4Xy1jVIjYXuQ" +
      "S+0DtbDCerrO89pAOF0RqbtGeXDZ8QC6syxgJNeiWZ8/e2ImeG0daS+H88fgZNDdStsMwVm5cbtBZxkcTYyQzJIc" +
      "uWigPkiuQnEuEl3rGFkLvYaNIwsmeCcbWeVm+gD/2Q==",
    expected:
      "HQJcAocCIQMAALYD0gSZAYQBbwGzBeUGegWeAfYCAAAJBNcEGQEPBr8FJgOWBMkGqQezA9sCGQICAvEEqQSUA4QG" +
      "+wQvB6kDTwg0CBwHAwNzAoACFAMkBnkECwhCBYIGKAZkCMcGlArLBO8BQQfKBbAGlAhUBdwEUAg+BooF0Ag3CTsG" +
      "nwclBukE8AbHBBwF0gWaCdoKMAhXB7EHEgTpCAoFIghOCN4HYQgqCvoKoAkFC48IUg2eB3QIMwkDBwEKnAvLCe8I" +
      "oQw7DIoNsgz7DYkJywduCg8IDQxHCqUKwwtaCvIJVw3lDBwO",
  },
];

function caseNamed(name: string): Case {
  const c = CASES.find((c) => c.name === name);
  if (c === undefined) throw new Error(name);
  return c;
}

// The offset of the 0xFF of the first `marker` segment before the scan data.
function segmentOffset(data: Uint8Array, marker: number): number {
  let pos = 2;
  while (data[pos + 1] !== marker) {
    if (data[pos + 1] === 0xda) throw new Error(`no marker ${marker}`);
    pos += 2 + ((data[pos + 2] << 8) | data[pos + 3]);
  }
  return pos;
}

function scanDataOffset(data: Uint8Array): number {
  const sos = segmentOffset(data, 0xda);
  return sos + 2 + ((data[sos + 2] << 8) | data[sos + 3]);
}

const GRAY = "gray 8-bit, predictor 1";
const RGB = "RGB 8-bit, predictor 5";
const RESTART =
  "RGB 8-bit, predictor 1, point transform 2, restart every 2 rows, COM and APP15";

describe("decodeLosslessJpeg", () => {
  test.each(CASES)("decodes $name ($encoder) as imagecodecs does", (c) => {
    const decoded = decodeLosslessJpeg(fromBase64(c.encoded));
    const expectedBytes = fromBase64(c.expected);
    const expected =
      c.outputBits === 8
        ? expectedBytes
        : new Uint16Array(expectedBytes.buffer);
    expect({
      width: decoded.width,
      height: decoded.height,
      numComponents: decoded.numComponents,
    }).toEqual({
      width: c.width,
      height: c.height,
      numComponents: c.numComponents,
    });
    expect(decoded.data).toEqual(expected);
  });

  function patched(name: string, patch: (data: Uint8Array) => void) {
    const data = fromBase64(caseNamed(name).encoded);
    patch(data);
    return data;
  }

  test("rejects data without an SOI marker", () => {
    const data = fromBase64(caseNamed(GRAY).encoded).subarray(2);
    expect(() => decodeLosslessJpeg(data)).toThrow(/SOI/);
  });

  test("rejects data that ends before a scan", () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(() => decodeLosslessJpeg(data)).toThrow(/ends before a scan/);
  });

  test("rejects a truncated marker segment", () => {
    const data = fromBase64(caseNamed(GRAY).encoded);
    const dht = segmentOffset(data, 0xc4);
    expect(() => decodeLosslessJpeg(data.subarray(0, dht + 10))).toThrow(
      /truncated marker segment/,
    );
  });

  test("rejects a DCT frame", () => {
    const data = patched(GRAY, (d) => {
      d[segmentOffset(d, 0xc3) + 1] = 0xc0;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/baseline DCT \(SOF0\)/);
  });

  test("rejects a precision above 16 bits", () => {
    const data = patched(GRAY, (d) => {
      d[segmentOffset(d, 0xc3) + 4] = 17;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/precision 17/);
  });

  test("rejects subsampled components", () => {
    const data = patched(RGB, (d) => {
      d[segmentOffset(d, 0xc3) + 11] = 0x21;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/subsampled/);
  });

  test("rejects a scan of only some of the components", () => {
    const data = fromBase64(caseNamed(RGB).encoded);
    const sos = segmentOffset(data, 0xda);
    const scan = scanDataOffset(data);
    // One component, its tables, predictor 5, Se 0 and Ah/Al 0.
    const oneComponent = [0xff, 0xda, 0, 8, 1, data[sos + 5], 0, 5, 0, 0];
    const patchedData = new Uint8Array([
      ...data.subarray(0, sos),
      ...oneComponent,
      ...data.subarray(scan),
    ]);
    expect(() => decodeLosslessJpeg(patchedData)).toThrow(
      /scan has 1 of the frame's 3 components/,
    );
  });

  test("rejects a scan that uses an undefined Huffman table", () => {
    const data = patched(GRAY, (d) => {
      d[segmentOffset(d, 0xda) + 6] = 0x10;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(
      /Huffman table 1 is not defined/,
    );
  });

  test("rejects a predictor outside 1 to 7", () => {
    const data = patched(GRAY, (d) => {
      d[segmentOffset(d, 0xda) + 7] = 0;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/predictor 0/);
  });

  test("rejects a point transform not less than the precision", () => {
    const data = patched(GRAY, (d) => {
      d[segmentOffset(d, 0xda) + 9] = 8;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/point transform 8/);
  });

  test("rejects a restart interval that is not a whole number of rows", () => {
    const data = patched(RESTART, (d) => {
      d[segmentOffset(d, 0xdd) + 5] -= 1;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(
      /restart interval 25 is not a multiple of the width 13/,
    );
  });

  test("rejects a missing restart marker", () => {
    const data = patched(RESTART, (d) => {
      let i = scanDataOffset(d);
      while (!(d[i] === 0xff && d[i + 1] === 0xd0)) ++i;
      d[i + 1] = 0xd9;
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(
      /expected a restart marker before row 2/,
    );
  });

  test("rejects an invalid Huffman code", () => {
    // Sixteen 1 bits: JPEG Huffman codes are never all ones.
    const data = patched(GRAY, (d) => {
      d.set([0xff, 0x00, 0xff, 0x00], scanDataOffset(d));
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(/invalid Huffman code/);
  });

  test("rejects a difference category above 16", () => {
    const data = patched(GRAY, (d) => {
      const dht = segmentOffset(d, 0xc4);
      const end = dht + 2 + ((d[dht + 2] << 8) | d[dht + 3]);
      d.fill(17, dht + 21, end);
    });
    expect(() => decodeLosslessJpeg(data)).toThrow(
      /invalid difference category 17/,
    );
  });

  test("rejects data that ends before the scan does", () => {
    const data = fromBase64(caseNamed(GRAY).encoded);
    const truncated = data.subarray(0, scanDataOffset(data) + 20);
    expect(() => decodeLosslessJpeg(truncated)).toThrow(
      /ends before the scan does/,
    );
  });
});
