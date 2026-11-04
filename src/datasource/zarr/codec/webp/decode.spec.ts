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

import { readFile } from "node:fs/promises";
import path from "node:path";
import { init } from "@jsquash/webp/decode.js";
import { beforeAll, expect, test } from "vitest";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import { webpChunkArray } from "#src/datasource/zarr/codec/webp/decode.js";
import "#src/datasource/zarr/codec/webp/resolve.js";
import { DataType } from "#src/util/data_type.js";
import { decodeWebpRgba } from "#src/util/webp.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

beforeAll(async () => {
  const wasm = await readFile(
    path.resolve(
      __dirname,
      "../../../../../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm",
    ),
  );
  await init(new WebAssembly.Module(wasm));
});

// Written by imagecodecs 2026.8.16's `webp_encode`. `expected` is what its
// `webp_decode(hasalpha=hasalpha)` returns, lossy streams included.
const CASES = [
  {
    name: "lossless RGB",
    shape: [12, 16, 3],
    hasalpha: false,
    encoded:
      "UklGRnYBAABXRUJQVlA4TGkBAAAvD8ACALkeRPQ/dhHR/wAs2XbbNn+uFPDwwAeo7Nk9WbvDSFLDVlIcCR7+X8iZQI4kSZG09OW966rMooYjiRlkjTh9Dj56iROSC9v4PsjX29K0nJ8H1MXgkW34GI94PvJfEcpcGM2SKWMXSVNlCE5FBc+9Geg+bux7zuMBUyoz6oTvFMJagkx8kynYKJWitq8zR2Rb7Ew1fAd+5sVk7ol4o8thVhRogvCs9XAgmQDQbxkft/yeHX7pUdG2Wr8uSceAzlopC6QNz4Tk7JHzyFVwtB7uyz1pBVYcOaLaYK8m+2e5QVFNWyXrz5wCYOnoRPcQX4KZ+iwDnLUlXCz+T4J0KldKlYI0ANaLzsTVpfoKIYOGlLeIMu2xdWAq8h275viWb36bNxXIWw8bFqWimjfWk1wdaCvI0QjVj84s9GROZHYgMnhn94Kl/kmpLoiWEyOdr+V8beJmEMWHJBC++j8QQXeIJhB9qpUTAA==",
    expected:
      "AAYEDhUcEx0qGS1EIzpaJUZuMVt/NGWXQHiuQX/CSY/SUJ3uVq4EYroRY8soado9ExgjFSc3GjRTJ0BjLVB1NF+MO2+kQXy3S4jRS5bgV6L4W7AQZcEdbdQ0cd9OfOhiFzJFI0BaJUtxLFqCMmeYQHmvQYPHSJTcUpztWKoAXrkWZsYxbNhCdOJTffVtgASDJUpnKVF+M2WOPG2qQH+6RIvRU5fnVaT7XbMSYMgib9E5cuJRe+1jfP16hgmOihufMlyKOm6ePXW0QoPISJHaVqX0XqwCX8EYZ84yctpEdeRdfPRyhwiCjRWdlCStnSu/Pm6oP4TBSpHRUZrkU6z7WrsQZ8glbNY/d+VNd/Fngvp/ig6MixajkiS6mzLMpEDiRInJSZfbU6D2W7MHYMEcbMszdNtGee1ce/dzhQmFjxWclyWtmC3DoTvbpE3srV0ITp7vVasDX7gUacsmbtZDceZSfvFrgwF9jRKWkx2nmyi5nDjRpUfprlT7tGUUt3EoXrQIX8Yjbs8zc9pMd/Befv11igmJkRqhlCC4nzTJnjzcq1Lvs1oLumkZu3c1x4hKZM0wcNg/eOJTevNohwSCjg6Wjxupmy/EojnUqUXnsFj/sGcXuHAnwIQ6y49PzpxkdeJKfOxigf16hwuPjhumlye7mDHQo0Hdq0/4sWAKu28iv30zxIxMzZhd0qF43q6Fe/lxhwiHiBKalh6ynC3Fo0DUp0vrqlYAtmoaunYvxINEyI9S1KJs1a2E3ruU6sqq",
  },
  {
    name: "lossless RGBA",
    shape: [12, 16, 4],
    hasalpha: true,
    encoded:
      "UklGRt4CAABXRUJQVlA4TNICAAAvD8ACEP8FObJt1cqWc668/9E5Q5IhB5IiV31yTxqQBLBt2wCgyKyOU/9/7rWv6Iu2BECubbdtBOB/gNlpwmqKSOVM/+spYEwCcmzbbRukH5FHa8mxC5fhBl2Jy/E+mxGIgJjX28cdbtEe3Vq/j0SvGIYft96BwfaWhxkpMGIw/Xefz63Wda4IrA4CNE/RoAVWhM4Na2gyI4mWYdsu6BElpa0eteD4dZboWdmqaVtMMiUoECg1ofDohDzV4ajkiOMywD9sqULAqQmjGF2jAyClKfIxoB+SlUzubk9EDVefyZxlOBKMIYmCOLUskFWW5IijigtmC5SyVRHZwT2NrILPrTtFJAxAp2KeQQNITZW6GyCXMShGjRh4b2cKhBwYgVx5+D+VrHJBxjW55OkYnaLkGkAREFbLYM5cuzmTiZUjnJsXyw6sWc5JYWGPKg9FIH507108TEg8eV3OGZoJRXHsL5FkOVQCTTBbQiWmNoNkrkNgRbWmjwkj1An4O7ZUYV2wNbBPiacrHcjpKTwKwkzoZ/sLew2O5oE3YA6JHYVUBI4UWsYMBoriCEJXxP0ixx2MZoDtuhf3GKaxIR6Y7loZAmoAJt2draOw2aXnrV+2vxbyztS41Fn5/mB/urzffbz/v/m/+d/99+H9PN/ffl4f+tE/P+b7tS7yZOa318+Xr8/fZ0AMAIBgMtu2bRvZtm3btm3btnszov8BAIKhCPQ/hSGUf1s9YXEgCByFI9E5ErXBHRSVngdDYghUtkChN/tCE7LL6rF4MpMr1ZicwTGpRZVtr0QaT6T8sfvDk3LKmzr7Rll8mfbXFRKbUVjd2jM8tSRWGW0BkSn5VY0dA5NzK5s6i/cvPrO49uNtZHphfffYERidnFvR3DU48bW6fXB6GZGYVVL33js2u7ixf3R+c5dWUNPSPfQ5v7ZzeHZ1+/BU2tDePz6zvLV3cnF9//j8Ag==",
    expected:
      "AAQAAAkWHB8QJCs/GCxDVh84W3IjTG6SKlyErDRlmsg7cajmQoXFAE6Q0xtRoec3VawDU129E29qyyyJadVCqhIWIi8aKzZLHzhQaiNIY4csT3ijMGCSwDpvptlAeLX1RYvNE1Kb3i1So/dJX7UNY2XAI31qzjaddOJMunTpXtYWMEZZHTtYeyRQbZUzWYisNWyXzTxyq+pEgMMIS5XbHVGk8ThWqgBXXb8Wd2jKKpBr2EOseOhXxX/2aeWFBX0AKUVrhjBYfqcxZJTEOXGq4ER6uPdHjM4TTZvhLlil/E5btxFsYsQkh2jUO55w4E/Ae/Fl1n/4dfGLDYsSkhWiLzNbi7Y7apvNOnu270OIyQhIldwmVZ71QFazBFxevxl0ac0sknDXRa5z61bPe/Ry54EDhgWPFJ0dlh+qO5gvw1Q5bqvcP3/C/kmQ1BZPmukzU635TWC0D2tpxCeGaNU9o3PeU79872bdgf94+YQPjRWQG6cvkie3T54yzmmjR+WERYnJDk6a3ChYpfhHV64FYWLBG3hnzDOabt9LtXrmXc59/HTriQOFCpARmyeRILQ+nizKWKQ63HqqTvOXr1sDsU+e7jpUrP5XW70WbWLKKYhq1EGndeJYxHv1aOSE/oD6hRKWFY0YqzKYJsFNoDvObKZD64ivVPmkr2AQvbptKdlbtgloY8IjgWbTN5hw4ki3dOxe2Hz3dvOGCo0IjxmcJJMitkCXLsden0TbeapR9peuXQy2uG0az7x5MO7ChEoHaccwjW3YRKx041jJe/dr6IUDgAKJD5oYkR6qN5svwVieN9Vyo0roi7BT/Kq4YRbEt3Ml3sCDO/3MkFUU05hmOHbiT8B362fUgfl78oQKkQ2RHKEpkym2RZo3yWinQt+DrEz2mK9fDLi5cCDUwnwz7siESQnKk1wl16dzSNewjV+A9WvmiASCBI0Rlx6VHrA6lS+/WZ481nOkS/CUrVkGsLFnFsjAcS3lv4Q/AsmQUhrNom882K2AUuK8kXDpy6eP",
  },
  {
    name: "lossy RGB",
    shape: [12, 16, 3],
    hasalpha: false,
    encoded:
      "UklGRnYBAABXRUJQVlA4TGkBAAAvD8ACALkeRPQ/dhHR/wAs2XbbNn+uFPDwwAeo7Nk9WbvDSFLDVlIcCR7+X8iZQI4kSZG09OW966rMooYjiRlkjTh9Dj56iROSC9v4PsjX29K0nJ8H1MXgkW34GI94PvJfEcpcGM2SKWMXSVNlCE5FBc+9Geg+bux7zuMBUyoz6oTvFMJagkx8kynYKJWitq8zR2Rb7Ew1fAd+5sVk7ol4o8thVhRogvCs9XAgmQDQbxkft/yeHX7pUdG2Wr8uSceAzlopC6QNz4Tk7JHzyFVwtB7uyz1pBVYcOaLaYK8m+2e5QVFNWyXrz5wCYOnoRPcQX4KZ+iwDnLUlXCz+T4J0KldKlYI0ANaLzsTVpfoKIYOGlLeIMu2xdWAq8h275viWb36bNxXIWw8bFqWimjfWk1wdaCvI0QjVj84s9GROZHYgMnhn94Kl/kmpLoiWEyOdr+V8beJmEMWHJBC++j8QQXeIJhB9qpUTAA==",
    expected:
      "AAYEDhUcEx0qGS1EIzpaJUZuMVt/NGWXQHiuQX/CSY/SUJ3uVq4EYroRY8soado9ExgjFSc3GjRTJ0BjLVB1NF+MO2+kQXy3S4jRS5bgV6L4W7AQZcEdbdQ0cd9OfOhiFzJFI0BaJUtxLFqCMmeYQHmvQYPHSJTcUpztWKoAXrkWZsYxbNhCdOJTffVtgASDJUpnKVF+M2WOPG2qQH+6RIvRU5fnVaT7XbMSYMgib9E5cuJRe+1jfP16hgmOihufMlyKOm6ePXW0QoPISJHaVqX0XqwCX8EYZ84yctpEdeRdfPRyhwiCjRWdlCStnSu/Pm6oP4TBSpHRUZrkU6z7WrsQZ8glbNY/d+VNd/Fngvp/ig6MixajkiS6mzLMpEDiRInJSZfbU6D2W7MHYMEcbMszdNtGee1ce/dzhQmFjxWclyWtmC3DoTvbpE3srV0ITp7vVasDX7gUacsmbtZDceZSfvFrgwF9jRKWkx2nmyi5nDjRpUfprlT7tGUUt3EoXrQIX8Yjbs8zc9pMd/Befv11igmJkRqhlCC4nzTJnjzcq1Lvs1oLumkZu3c1x4hKZM0wcNg/eOJTevNohwSCjg6Wjxupmy/EojnUqUXnsFj/sGcXuHAnwIQ6y49PzpxkdeJKfOxigf16hwuPjhumlye7mDHQo0Hdq0/4sWAKu28iv30zxIxMzZhd0qF43q6Fe/lxhwiHiBKalh6ynC3Fo0DUp0vrqlYAtmoaunYvxINEyI9S1KJs1a2E3ruU6sqq",
  },
  {
    name: "lossy RGB, low quality",
    shape: [12, 16, 3],
    hasalpha: false,
    encoded:
      "UklGRnYBAABXRUJQVlA4TGkBAAAvD8ACALkeRPQ/dhHR/wAs2XbbNn+uFPDwwAeo7Nk9WbvDSFLDVlIcCR7+X8iZQI4kSZG09OW966rMooYjiRlkjTh9Dj56iROSC9v4PsjX29K0nJ8H1MXgkW34GI94PvJfEcpcGM2SKWMXSVNlCE5FBc+9Geg+bux7zuMBUyoz6oTvFMJagkx8kynYKJWitq8zR2Rb7Ew1fAd+5sVk7ol4o8thVhRogvCs9XAgmQDQbxkft/yeHX7pUdG2Wr8uSceAzlopC6QNz4Tk7JHzyFVwtB7uyz1pBVYcOaLaYK8m+2e5QVFNWyXrz5wCYOnoRPcQX4KZ+iwDnLUlXCz+T4J0KldKlYI0ANaLzsTVpfoKIYOGlLeIMu2xdWAq8h275viWb36bNxXIWw8bFqWimjfWk1wdaCvI0QjVj84s9GROZHYgMnhn94Kl/kmpLoiWEyOdr+V8beJmEMWHJBC++j8QQXeIJhB9qpUTAA==",
    expected:
      "AAYEDhUcEx0qGS1EIzpaJUZuMVt/NGWXQHiuQX/CSY/SUJ3uVq4EYroRY8soado9ExgjFSc3GjRTJ0BjLVB1NF+MO2+kQXy3S4jRS5bgV6L4W7AQZcEdbdQ0cd9OfOhiFzJFI0BaJUtxLFqCMmeYQHmvQYPHSJTcUpztWKoAXrkWZsYxbNhCdOJTffVtgASDJUpnKVF+M2WOPG2qQH+6RIvRU5fnVaT7XbMSYMgib9E5cuJRe+1jfP16hgmOihufMlyKOm6ePXW0QoPISJHaVqX0XqwCX8EYZ84yctpEdeRdfPRyhwiCjRWdlCStnSu/Pm6oP4TBSpHRUZrkU6z7WrsQZ8glbNY/d+VNd/Fngvp/ig6MixajkiS6mzLMpEDiRInJSZfbU6D2W7MHYMEcbMszdNtGee1ce/dzhQmFjxWclyWtmC3DoTvbpE3srV0ITp7vVasDX7gUacsmbtZDceZSfvFrgwF9jRKWkx2nmyi5nDjRpUfprlT7tGUUt3EoXrQIX8Yjbs8zc9pMd/Befv11igmJkRqhlCC4nzTJnjzcq1Lvs1oLumkZu3c1x4hKZM0wcNg/eOJTevNohwSCjg6Wjxupmy/EojnUqUXnsFj/sGcXuHAnwIQ6y49PzpxkdeJKfOxigf16hwuPjhumlye7mDHQo0Hdq0/4sWAKu28iv30zxIxMzZhd0qF43q6Fe/lxhwiHiBKalh6ynC3Fo0DUp0vrqlYAtmoaunYvxINEyI9S1KJs1a2E3ruU6sqq",
  },
  {
    name: "lossy RGBA",
    shape: [12, 16, 4],
    hasalpha: true,
    encoded:
      "UklGRt4CAABXRUJQVlA4TNICAAAvD8ACEP8FObJt1cqWc668/9E5Q5IhB5IiV31yTxqQBLBt2wCgyKyOU/9/7rWv6Iu2BECubbdtBOB/gNlpwmqKSOVM/+spYEwCcmzbbRukH5FHa8mxC5fhBl2Jy/E+mxGIgJjX28cdbtEe3Vq/j0SvGIYft96BwfaWhxkpMGIw/Xefz63Wda4IrA4CNE/RoAVWhM4Na2gyI4mWYdsu6BElpa0eteD4dZboWdmqaVtMMiUoECg1ofDohDzV4ajkiOMywD9sqULAqQmjGF2jAyClKfIxoB+SlUzubk9EDVefyZxlOBKMIYmCOLUskFWW5IijigtmC5SyVRHZwT2NrILPrTtFJAxAp2KeQQNITZW6GyCXMShGjRh4b2cKhBwYgVx5+D+VrHJBxjW55OkYnaLkGkAREFbLYM5cuzmTiZUjnJsXyw6sWc5JYWGPKg9FIH507108TEg8eV3OGZoJRXHsL5FkOVQCTTBbQiWmNoNkrkNgRbWmjwkj1An4O7ZUYV2wNbBPiacrHcjpKTwKwkzoZ/sLew2O5oE3YA6JHYVUBI4UWsYMBoriCEJXxP0ixx2MZoDtuhf3GKaxIR6Y7loZAmoAJt2draOw2aXnrV+2vxbyztS41Fn5/mB/urzffbz/v/m/+d/99+H9PN/ffl4f+tE/P+b7tS7yZOa318+Xr8/fZ0AMAIBgMtu2bRvZtm3btm3btnszov8BAIKhCPQ/hSGUf1s9YXEgCByFI9E5ErXBHRSVngdDYghUtkChN/tCE7LL6rF4MpMr1ZicwTGpRZVtr0QaT6T8sfvDk3LKmzr7Rll8mfbXFRKbUVjd2jM8tSRWGW0BkSn5VY0dA5NzK5s6i/cvPrO49uNtZHphfffYERidnFvR3DU48bW6fXB6GZGYVVL33js2u7ixf3R+c5dWUNPSPfQ5v7ZzeHZ1+/BU2tDePz6zvLV3cnF9//j8Ag==",
    expected:
      "AAQAAAkWHB8QJCs/GCxDVh84W3IjTG6SKlyErDRlmsg7cajmQoXFAE6Q0xtRoec3VawDU129E29qyyyJadVCqhIWIi8aKzZLHzhQaiNIY4csT3ijMGCSwDpvptlAeLX1RYvNE1Kb3i1So/dJX7UNY2XAI31qzjaddOJMunTpXtYWMEZZHTtYeyRQbZUzWYisNWyXzTxyq+pEgMMIS5XbHVGk8ThWqgBXXb8Wd2jKKpBr2EOseOhXxX/2aeWFBX0AKUVrhjBYfqcxZJTEOXGq4ER6uPdHjM4TTZvhLlil/E5btxFsYsQkh2jUO55w4E/Ae/Fl1n/4dfGLDYsSkhWiLzNbi7Y7apvNOnu270OIyQhIldwmVZ71QFazBFxevxl0ac0sknDXRa5z61bPe/Ry54EDhgWPFJ0dlh+qO5gvw1Q5bqvcP3/C/kmQ1BZPmukzU635TWC0D2tpxCeGaNU9o3PeU79872bdgf94+YQPjRWQG6cvkie3T54yzmmjR+WERYnJDk6a3ChYpfhHV64FYWLBG3hnzDOabt9LtXrmXc59/HTriQOFCpARmyeRILQ+nizKWKQ63HqqTvOXr1sDsU+e7jpUrP5XW70WbWLKKYhq1EGndeJYxHv1aOSE/oD6hRKWFY0YqzKYJsFNoDvObKZD64ivVPmkr2AQvbptKdlbtgloY8IjgWbTN5hw4ki3dOxe2Hz3dvOGCo0IjxmcJJMitkCXLsden0TbeapR9peuXQy2uG0az7x5MO7ChEoHaccwjW3YRKx041jJe/dr6IUDgAKJD5oYkR6qN5svwVieN9Vyo0roi7BT/Kq4YRbEt3Ml3sCDO/3MkFUU05hmOHbiT8B362fUgfl78oQKkQ2RHKEpkym2RZo3yWinQt+DrEz2mK9fDLi5cCDUwnwz7siESQnKk1wl16dzSNewjV+A9WvmiASCBI0Rlx6VHrA6lS+/WZ481nOkS/CUrVkGsLFnFsjAcS3lv4Q/AsmQUhrNom882K2AUuK8kXDpy6eP",
  },
  {
    name: "no alpha in the stream, RGBA chunk",
    shape: [12, 16, 4],
    hasalpha: true,
    encoded:
      "UklGRnQBAABXRUJQVlA4TGgBAAAvD8ACALkeRPQ/dlGI6H8AgttGjqQNl6+7ynaF7p399OX7usMAaNsmaS0hkFDX/7cWciRJiqR7MhRmZeWyyscnbcTDdSeO4fmlcqDyGBCvsoGnxL7PPZ/xfpb1bI63P/Rl2Sh1tXcGRZfRViler/Y4xQLdIFptmce5WczKnu/ZmUMO4kYl+R648QfKCNUmmT1Zv8M2gEOAw97YqpozgUkhuCzW1sjs6SG2RHmeo5QZa8sVCHzL5j2NcIk5/y86vY4ijxHHsBvRFT7ORYZmb3VJ1Vla4JkuruJ9psfg9RPpb6VWarz8AM3+0QMcfZvTm0tG6YLsChbHS/KUnGLFWkrinlfg0DJ/Eq09xflPTI4TQCGbv7JJEnlUqI+RLH0EQYh7SYx1F6GtL0rybDqw2eOV3pPHg6Oljd1NS2laqXZkdla5E0IWl35SMQdI9BQflxDS8c2iW4+GoDpGqeLb3pnPAWvHJVzqKDs=",
    expected:
      "AAQA/wkWHP8QJCv/GCxD/x84W/8jTG7/KlyE/zRlmv87caj/QoXF/06Q0/9Roef/VawD/129E/9qyyz/adVC/xIWIv8aKzb/HzhQ/yNIY/8sT3j/MGCS/zpvpv9AeLX/RYvN/1Kb3v9So/f/X7UN/2XAI/9qzjb/dOJM/3TpXv8WMEb/HTtY/yRQbf8zWYj/NWyX/zxyq/9EgMP/S5Xb/1Gk8f9WqgD/Xb8W/2jKKv9r2EP/eOhX/3/2af+FBX3/KUVr/zBYfv8xZJT/OXGq/0R6uP9HjM7/TZvh/1il/P9btxH/YsQk/2jUO/9w4E//e/Fl/3/4df+LDYv/khWi/zNbi/87apv/Onu2/0OIyf9Ildz/VZ71/1azBP9evxn/ac0s/3DXRf9z61b/e/Ry/4EDhv+PFJ3/lh+q/5gvw/85bqv/P3/C/0mQ1P9Pmun/U635/2C0D/9pxCf/aNU9/3PeU/9872b/gf94/4QPjf+QG6f/kie3/54yzv+jR+X/RYnJ/06a3P9Ypfj/V64F/2LBG/9nzDP/bt9L/3rmXf99/HT/iQOF/5ARm/+RILT/nizK/6Q63P+qTvP/r1sD/0+e7v9UrP7/W70W/2LKKf9q1EH/deJY/3v1aP+E/oD/hRKW/40Yq/+YJsH/oDvO/6ZD6/+vVPn/r2AQ/7ptKf9btgn/Y8Ij/2bTN/9w4kj/dOxe/3z3dv+GCo3/jxmc/5Mitv+XLsf/n0Tb/6pR9v+uXQz/uG0a/7x5MP/ChEr/accw/23YRP9041j/e/dr/4UDgP+JD5r/kR6q/5svwf+eN9X/o0ro/7BT/P+4YRb/t3Ml/8CDO//MkFX/05hm/3biT/9362f/gfl7/4QKkf+RHKH/kym2/5o3yf+nQt//rEz2/69fDP+5cCD/wnwz/8iESf/Kk1z/16dz/9ewjf+A9Wv/iASC/40Rl/+VHrD/lS+//5481v+kS/D/rVkG/7FnFv/AcS3/v4Q//8mQUv/Nom//2K2A/+K8kf/py6f/",
  },
  {
    name: "lossy, no alpha in the stream, RGBA chunk",
    shape: [12, 16, 4],
    hasalpha: true,
    encoded:
      "UklGRnYBAABXRUJQVlA4TGkBAAAvD8ACALkeRPQ/dhHR/wAs2XbbNn+uFPDwwAeo7Nk9WbvDSFLDVlIcCR7+X8iZQI4kSZG09OW966rMooYjiRlkjTh9Dj56iROSC9v4PsjX29K0nJ8H1MXgkW34GI94PvJfEcpcGM2SKWMXSVNlCE5FBc+9Geg+bux7zuMBUyoz6oTvFMJagkx8kynYKJWitq8zR2Rb7Ew1fAd+5sVk7ol4o8thVhRogvCs9XAgmQDQbxkft/yeHX7pUdG2Wr8uSceAzlopC6QNz4Tk7JHzyFVwtB7uyz1pBVYcOaLaYK8m+2e5QVFNWyXrz5wCYOnoRPcQX4KZ+iwDnLUlXCz+T4J0KldKlYI0ANaLzsTVpfoKIYOGlLeIMu2xdWAq8h275viWb36bNxXIWw8bFqWimjfWk1wdaCvI0QjVj84s9GROZHYgMnhn94Kl/kmpLoiWEyOdr+V8beJmEMWHJBC++j8QQXeIJhB9qpUTAA==",
    expected:
      "AAYE/w4VHP8THSr/GS1E/yM6Wv8lRm7/MVt//zRll/9AeK7/QX/C/0mP0v9Qne7/Vq4E/2K6Ef9jyyj/ado9/xMYI/8VJzf/GjRT/ydAY/8tUHX/NF+M/ztvpP9BfLf/S4jR/0uW4P9Xovj/W7AQ/2XBHf9t1DT/cd9O/3zoYv8XMkX/I0Ba/yVLcf8sWoL/MmeY/0B5r/9Bg8f/SJTc/1Kc7f9YqgD/XrkW/2bGMf9s2EL/dOJT/331bf+ABIP/JUpn/ylRfv8zZY7/PG2q/0B/uv9Ei9H/U5fn/1Wk+/9dsxL/YMgi/2/ROf9y4lH/e+1j/3z9ev+GCY7/ihuf/zJciv86bp7/PXW0/0KDyP9Ikdr/VqX0/16sAv9fwRj/Z84y/3LaRP915F3/fPRy/4cIgv+NFZ3/lCSt/50rv/8+bqj/P4TB/0qR0f9RmuT/U6z7/1q7EP9nyCX/bNY//3flTf938Wf/gvp//4oOjP+LFqP/kiS6/5syzP+kQOL/RInJ/0mX2/9ToPb/W7MH/2DBHP9syzP/dNtG/3ntXP9793P/hQmF/48VnP+XJa3/mC3D/6E72/+kTez/rV0I/06e7/9VqwP/X7gU/2nLJv9u1kP/ceZS/37xa/+DAX3/jRKW/5Mdp/+bKLn/nDjR/6VH6f+uVPv/tGUU/7dxKP9etAj/X8Yj/27PM/9z2kz/d/Be/379df+KCYn/kRqh/5QguP+fNMn/njzc/6tS7/+zWgv/umkZ/7t3Nf/HiEr/ZM0w/3DYP/944lP/evNo/4cEgv+ODpb/jxup/5svxP+iOdT/qUXn/7BY//+wZxf/uHAn/8CEOv/Lj0//zpxk/3XiSv987GL/gf16/4cLj/+OG6b/lye7/5gx0P+jQd3/q0/4/7FgCv+7byL/v30z/8SMTP/NmF3/0qF4/96uhf97+XH/hwiH/4gSmv+WHrL/nC3F/6NA1P+nS+v/qlYA/7ZqGv+6di//xINE/8iPUv/Uomz/1a2E/967lP/qyqr/",
  },
  {
    name: "alpha in the stream, RGB chunk",
    shape: [12, 16, 3],
    hasalpha: false,
    encoded:
      "UklGRt4CAABXRUJQVlA4TNICAAAvD8ACEP8FObJt1cqWc668/9E5Q5IhB5IiV31yTxqQBLBt2wCgyKyOU/9/7rWv6Iu2BECubbdtBOB/gNlpwmqKSOVM/+spYEwCcmzbbRukH5FHa8mxC5fhBl2Jy/E+mxGIgJjX28cdbtEe3Vq/j0SvGIYft96BwfaWhxkpMGIw/Xefz63Wda4IrA4CNE/RoAVWhM4Na2gyI4mWYdsu6BElpa0eteD4dZboWdmqaVtMMiUoECg1ofDohDzV4ajkiOMywD9sqULAqQmjGF2jAyClKfIxoB+SlUzubk9EDVefyZxlOBKMIYmCOLUskFWW5IijigtmC5SyVRHZwT2NrILPrTtFJAxAp2KeQQNITZW6GyCXMShGjRh4b2cKhBwYgVx5+D+VrHJBxjW55OkYnaLkGkAREFbLYM5cuzmTiZUjnJsXyw6sWc5JYWGPKg9FIH507108TEg8eV3OGZoJRXHsL5FkOVQCTTBbQiWmNoNkrkNgRbWmjwkj1An4O7ZUYV2wNbBPiacrHcjpKTwKwkzoZ/sLew2O5oE3YA6JHYVUBI4UWsYMBoriCEJXxP0ixx2MZoDtuhf3GKaxIR6Y7loZAmoAJt2draOw2aXnrV+2vxbyztS41Fn5/mB/urzffbz/v/m/+d/99+H9PN/ffl4f+tE/P+b7tS7yZOa318+Xr8/fZ0AMAIBgMtu2bRvZtm3btm3btnszov8BAIKhCPQ/hSGUf1s9YXEgCByFI9E5ErXBHRSVngdDYghUtkChN/tCE7LL6rF4MpMr1ZicwTGpRZVtr0QaT6T8sfvDk3LKmzr7Rll8mfbXFRKbUVjd2jM8tSRWGW0BkSn5VY0dA5NzK5s6i/cvPrO49uNtZHphfffYERidnFvR3DU48bW6fXB6GZGYVVL33js2u7ixf3R+c5dWUNPSPfQ5v7ZzeHZ1+/BU2tDePz6zvLV3cnF9//j8Ag==",
    expected:
      "AAQACRYcECQrGCxDHzhbI0xuKlyENGWaO3GoQoXFTpDTUaHnVawDXb0TasssadVCEhYiGis2HzhQI0hjLE94MGCSOm+mQHi1RYvNUpveUqP3X7UNZcAjas42dOJMdOleFjBGHTtYJFBtM1mINWyXPHKrRIDDS5XbUaTxVqoAXb8WaMoqa9hDeOhXf/ZphQV9KUVrMFh+MWSUOXGqRHq4R4zOTZvhWKX8W7cRYsQkaNQ7cOBPe/Flf/h1iw2LkhWiM1uLO2qbOnu2Q4jJSJXcVZ71VrMEXr8Zac0scNdFc+tWe/RygQOGjxSdlh+qmC/DOW6rP3/CSZDUT5rpU635YLQPacQnaNU9c95TfO9mgf94hA+NkBunkie3njLOo0flRYnJTprcWKX4V64FYsEbZ8wzbt9LeuZdffx0iQOFkBGbkSC0nizKpDrcqk7zr1sDT57uVKz+W70WYsopatRBdeJYe/VohP6AhRKWjRirmCbBoDvOpkPrr1T5r2AQum0pW7YJY8IjZtM3cOJIdOxefPd2hgqNjxmckyK2ly7Hn0TbqlH2rl0MuG0avHkwwoRKaccwbdhEdONYe/drhQOAiQ+akR6qmy/BnjfVo0rosFP8uGEWt3MlwIM7zJBV05hmduJPd+tngfl7hAqRkRyhkym2mjfJp0LfrEz2r18MuXAgwnwzyIRJypNc16dz17CNgPVriASCjRGXlR6wlS+/njzWpEvwrVkGsWcWwHEtv4Q/yZBSzaJv2K2A4ryR6cun",
  },
];

test("decodes as imagecodecs does", async () => {
  for (const { shape, hasalpha, encoded, expected } of CASES) {
    const chunkShape = [1, ...shape];
    parseCodecChainSpec(
      [{ name: "imagecodecs_webp", configuration: { hasalpha } }],
      { dataType: DataType.UINT8, chunkShape },
    );
    expect(
      webpChunkArray(chunkShape, await decodeWebpRgba(fromBase64(encoded))),
    ).toEqual(fromBase64(expected));
  }
});

test("rejects other data types", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_webp" }], {
      dataType: DataType.UINT16,
      chunkShape: [2, 2, 3],
    }),
  ).toThrow(/supports the uint8 data type, not uint16/);
});

test("rejects a chunk without 3 or 4 samples", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_webp" }], {
      dataType: DataType.UINT8,
      chunkShape: [2, 2, 2],
    }),
  ).toThrow(/is not one image of 3 or 4 samples/);
});

test("rejects a chunk of less than three dimensions", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_webp" }], {
      dataType: DataType.UINT8,
      chunkShape: [2, 3],
    }),
  ).toThrow(/is not one image of 3 or 4 samples/);
});

test("rejects a chunk of more than one image", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_webp" }], {
      dataType: DataType.UINT8,
      chunkShape: [2, 2, 2, 3],
    }),
  ).toThrow(/is not one image of 3 or 4 samples/);
});

test("rejects a hasalpha that disagrees with the shape", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_webp", configuration: { hasalpha: true } }],
      { dataType: DataType.UINT8, chunkShape: [2, 2, 3] },
    ),
  ).toThrow(/hasalpha true does not agree with 3 samples/);
});

test("rejects a hasalpha that is not a boolean", () => {
  expect(() =>
    parseCodecChainSpec(
      [{ name: "imagecodecs_webp", configuration: { hasalpha: 1 } }],
      { dataType: DataType.UINT8, chunkShape: [2, 2, 4] },
    ),
  ).toThrow(/Expected boolean/);
});

test("rejects an image that does not fill the chunk", () => {
  expect(() =>
    webpChunkArray([2, 2, 4], {
      width: 3,
      height: 2,
      rgba: new Uint8Array(24),
    }),
  ).toThrow(/WebP image of height 2 and width 3 does not fill a chunk/);
});

test("rejects a stream that is not WebP", async () => {
  await expect(decodeWebpRgba(new Uint8Array(64))).rejects.toThrow(
    /Decoding error/,
  );
});
