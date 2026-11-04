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
import { beforeAll, expect, test, vi } from "vitest";
import { jxlChunkArray } from "#src/datasource/zarr/codec/jpegxl/decode.js";
import "#src/datasource/zarr/codec/jpegxl/resolve.js";
import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import {
  decompressJxl,
  decompressJxlSamples,
} from "#src/sliceview/jxl/index.js";
import { DataType } from "#src/util/data_type.js";

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const data = await readFile(
        path.resolve(__dirname, "../../../../sliceview/jxl/jxl_decoder.wasm"),
      );
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": "application/wasm" },
      });
    }),
  );
});

const DATA_TYPES = {
  uint8: DataType.UINT8,
  uint16: DataType.UINT16,
  float32: DataType.FLOAT32,
} as const;

// Written by imagecodecs 2026.8.16's `jpegxl_encode` with `lossless=True`, which
// `jpegxl_decode` reads back. `expected` is little-endian.
const CASES = [
  {
    name: "u1 1 lossless",
    shape: [12, 16],
    dtype: "uint8",
    encoded:
      "/wpYMBAUNwIIAAEA4AFLEsWCBVIgobYtyHREdAzd8cJMACjaoq7GGn6IvAFWwnesNhPomqlQpSjM5VfFEQQOlw4gTII1upibgYQ491I5V/hpVHkESlzzrjHv5QafQEUEA8x4mNbUMVEZHKjKydpBECbankxMBCxITJPkx9rRHZobBZcFqA4=",
    expected:
      "BAoRGCQmLzQ7QUhUWl5mcBIZGiUpMzxBS01VWmZscHgeJSkxOTpDR1FZXWhqeH6FITA2OUNETFhhaG9vfIKDizI6PkJLUVhhanByfYGJlJY4QElPW1tland6gYWTmJmiRkxWXmNrbHt9iYuUmZ2qrU9bW2VrcXeDiZKbnKGrtb5eYWxxeIKJipefo6WttMLJZ3B2eYeMkZydo6+0uMTJ0HB3foWNlaCkqbS1vcXQ1td9gI+Pm6Spsbm5w83V29/l",
  },
  {
    name: "u1 3 lossless",
    shape: [12, 16, 3],
    dtype: "uint8",
    encoded:
      "/wpYMBAJCAABAKQHSxIJEhg4BMEkBQVWVG1tqS3bwnWteHeKkdcYKxccgGkSAYBDAQBtE1C1LBhSgFQ2GGSgjKPo3DRMg68iogIiY40QhSwbY9FTYN3TAbmeLwb7Xefde7nJpbkRGoaGBi+B8pfpKhMF9tTHvZTrInN7K6cII3/T8WeJ2iwv3SEfih8sPWMwS9hLCtailD2sKQkQasv0lD/0scJMlUeRy48nYXEMdq90kBBR7LgSsfvZBhLisiKPeLAvTZCIXeQskQZHxU7a8/TC+oGQpXlL9o5hQ5Y5NyZFSMA/tWvpJ6xdyN5eV3vL0vjfoMukM9xVZLO4DrzOlzxNW3f3Bd4GUHpePl3+FFmpGzu5WmutRlJnWIf6wggfBSEWDLKIl/hjT07gWWHwtrgb5OIxcZPWK4MPJnCltBr2+8oARXshVuDyoaRzf41l9NZ6uta6tCLEd58cvrn00MusKCgsP66Saene/SrhvmkE1fEShOHJwo5BM9CBq3lErvhoT03EXRpCxYzUJL7yVIanKcsoJoqsSBrICdewU8V4Ol3hwzx0lQhp96pTCsk9elGf+gNbYo2Aq87wR9RBzC8BlM4p12kDlJMU3PANkKLDtxH9glL++aGkZppaq+IdmmwhwuYs2Cvjnw5kxz29B2IgzgoC",
    expected:
      "AAEDDw8XFiIrGC1FHkBZJEpvKliANWaXOXatRYbASI/ZVJ3pVa/9Yb4SY8smbdI+ERgoGSU2GjpRIUFnK1J3Ll6KOHCjPXq5SI3NUZvfV6L1X7gNZcMdZ880dNxJduhgHTRGITtaKE90MlyHN2ubPHKvRoXIT5LXVp/sWrAAXr8basssbdQ+dOpafPhogQGFKUJnK1d7MGCQPWyqPoC+RozRT5vpVqf4XLMQZcchadA3bt5Oeeplfvl5iAeJihuiL1qFOGyeQni0Q4LJSJLbVp7uXK8EZMEeas0sbtpIeOZcf/hxhgeHjxKakSGtmyvGPHGtQoK7S4rUUaDmVqz8XLwRYckjcNg/c+RRfe1pgQB+hAyUkBylliu8nDrRp0PmQojOTJXbVKT1X7MFZr8ebM4zbttGeO1bfvt0iAWDixeYliOxmDDDokDYqUvxsFoJVaDvXKr/Yb4YaMoqa9U7c+hWd/Rngf9/iA+QjBirlirAojjUp0fksFj5r2ASunEqXbgKX8AiatEycN5Kdexhf/xxiAqNiRqgmCK0lzTFpT3erU7wrFkFtWofv3cvxodHaM4sbdZAd+dUefBtggGDhxSSkiCvlSu9nD7Xp0vprFX+s2EVvHMlxn1Cx5FSzZ9ndOFNd/Fhgfh0gw2NjRijmCO2njjKoj/eqFH1sloPvGkfwnY1xotGy5hb1ad23bWMevdshwWIjQ6dkiSwnTDCoDjWqErprlgAsWkVvXEvxYM/x5RY0Zts1a98276Z6sSp",
  },
  {
    name: "u1 4 lossless",
    shape: [12, 16, 4],
    dtype: "uint8",
    encoded:
      "/wpYMLASCAAQAHgKSxIJEhg4BEFIgRUNUtVWUgu7dhWMoxSzdwCuYAwArJmBb8vCHEZESB1ZxMtUehFMyqgXdoC9AnDWlKUaiwXUewcGNgF1E5HPZm4R1h7f6TQPehAA3AURNOP3ugE0iICGa5B9gSIIqqDiCISdQ2Qn+TGRRIrGPZnYBvQPEZpPZMF2zjco2QxwnzxIFQBXzibjq4DxgclKA2XH3JraCMjt3W9+0J02OIpmWhepl6IAnqf2UooWQWlG44bU+CPR/yN+MCOXuw9ObVyjiZtazm27Jnnuxb2z/rx8Szajb7ovVnUV8izwd716v5S0KRYyZqp1GWnSAKZY7ftIe31rMSjJ9ZRo0E/sy/2VDkOHWQeDgYlAy7ePZed6ieJbgJ+R3oRfJtDfi3XTufALlkZaWOxFJMgJl1YzwfIUGC7yj/9ZIb4sjYQtTrbw6wfvEhx2nC+TXJXi+LkKbwByThBEu+dlCgDYDxQAkCzAQ+8lCPikj2u0c7sEYSMEQLoZUN9rhz3OtGLFP8IZKQwdGBWMjmzWPSjIjNJETTAQaw5w2rSCxGT9DFiDQFAA6GcGZrHh+4R5InycJka/byooGJGoEDtIP8KBaUmAZLVruFh4WgiAtgsWzoEZCJUFCjZTo9TvNxHChi8ES3ly7Xo1bLuSuDBo0GCT+J5zhiSyKyRRWfIgYqDZt0bUyQPAcClvV4HowiPo3kBxymKQ32Lww02ezirAgKo625efg9jvE0kNSOx0Ydg5JT0UBsMyO4F3hYHzd8ifi87dbz+IaXNBrlb483oIp7RISNmMnKcw94wpkqqAQuJAHGxYoAdrg3Y59vfE8bMVBKekxm8XewPzCIOZuWs+wGcE96BYzC4syOFqfBkni9xCIAIsanYRQeVLEAKmBQ==",
    expected:
      "BQEAAgkTFiIWHC84FipHWiBAVngnR3GPL1aFrzZilsQ5dqnlQ4LA/EuM2CBOouo7Wqr9VV23EW9qxSuLb9M8rA0YKS0SJThLHTRLbCVFYoEuTnyiMGCMvjxwptw8fLX3SI7NDEyY5DBUqfNMXLIMY2C+H4RnzjWgdeBMuHvsXdUYMUZaJUJfdyxPb5IyXYiuMmqWyTt1sORIgMQESo/bIFSg8D5arf9YXb0adWbGKpJq2UOud+ZayID0auWG/oECIkNriTBVgKc1YZS/N2yk3T5/v/hGjswTU5bkMVaq9kleuAxoYMcihW7OPaBy30q7euti3H0AdfaIB44MjhSlKS5biLg7bJvUP3ev6UmFyQhJkN8kVp7tQ1myCltdwBp0a8ozlHPWSK907FnQe/pr6IEGhwGPE5YjlB2sPpcxxFw7b6zgPoC7+0eS0xhNneYwU64AU164FmpjxyiIcNI/oHXiTcJ78mbZgfp99IwOkBeRGKEzliu5SZw402uhQuGHQovNC1GT3idTpfdHV7ENZGLDHn1pzTKcb9hHtXnsX81/9nDtggiKDI0UoCaWILNBmDLKXKA/3nSsT/CUrVsIs1Sg6jxXrgJQY7kYbWnGK45w2EGrduBVwH/zaOGA/n79ig+TGo4YqzWZKrlPoTbTbqVK44muV/mitF4Nv7p0KN1etg5oZ8UegmzMN5xx20q4d+ph1nv8dfSKCooLixmeKpIltkWXMstjnz7bgKpM85qsWgS4uWwb0rt1LvDDhEYKY8ovkW3aQrBy6FnHfPRp54YCgv+LDJkgjxqtPJcpvFWbONZ0qkbmjK5VAaS1aBHIvXUr3sB/PfrFjU8czZ1mNW7jUr928WLcgPx19YQOkRKQGJ4skSm1S5oxzGSmQ+N9qkz0nbVhCby7aB7Wu3wy7siLTAnMl2Mk16V1Q9q0imGB9nHmgQiBB4wQlR+OHK0+mi7BWqI+1XKrTvGSrFUBqblpF8m6di/lwYY9BM2PVhjOnWc71rCEUN64lXLlyKmK",
  },
  {
    name: "u2 1 lossless",
    shape: [12, 16],
    dtype: "uint16",
    encoded:
      "AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAJanhsbAoAAAFdanhsY/8KWDD8AEWLCAABABwFSxLFggVSYKNi8MyoGCRJjIyuBLu2HVqcgvUBAEQ7BQQWKriud8DAQgOuHwooIIBAQvJvAgwIJFRHDQYYJvc8DKcpOpzqlBtmdyKJJeerREJ2MAkDzD/PyRUQR1E1AUpE5m2w4L2NR4ySjFzTidobW0IDWgV74HY7Dp05LQeMDVCQfRn2C0GPwjL8qXjAZHuikBH4kMr248QgAq1KOylwdnjLgJKDBvdwK61mhaWjJy4ewWCkxYGBK9Jumi8rg1IEgQmJQlAKFLsAgRs/JKoCThUYoPtX6vwIh5T6kGs1AK1UIAIipMJgc8eaT7g4CgRTUUBLqNRSwqMtGCT1y4FIkgTGR8BboWmH22ueHgJZbiRMTDFAkOs3t5AAAgaW3P5BwrvGEqPAR7QMFKoZx0zqDQIFro478kPAmQOgoM1H+kkzAF2i57kH",
    expected:
      "BQUHBxISFxceHiQkLy8yMjw8RkZISFBQWVlbW2dnaWkQEBMTGhokJCkpNTU2NkBASkpLS1VVXV1mZm1tc3N3dxwcJSUkJDMzNjY7O0FBR0dQUFdXZGRmZnJycXF7e4ODJiYoKC8vOjpEREdHUlJTU11dY2NsbHJyeXmAgIaGjo4uLjk5Pj5BQVBQUFBbW2JiZWVzc3R0fHyDg4uLkZGbmzg4Pj5GRlNTVlZeXmhoaGh3d3t7hISLi5KSmZmgoKKiRkZNTVZWXFxfX2trc3N6enx8hYWLi5OTnJyhoaamrKxNTVtbYmJnZ3BwdnZ4eISEhoaQkJaWnp6mpqmpsbG4uFhYX19nZ29vdHSAgIeHkZGSkpubnp6np7Kyurq8vMjIZ2dycnJygICAgIeHlJSbm5ycqqqsrLi4u7vFxcvLz89ubn19goKKipCQlpaamqWlpqaysry8vb3KysnJ1tbc3IGBh4eMjJSUmJicnKmpsLC4uLi4xMTLy9HR19fi4uPj",
  },
  {
    name: "u2 3 lossless",
    shape: [12, 16, 3],
    dtype: "uint16",
    encoded:
      "AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAJanhsbAoAAARUanhsY/8KWDD8ABQtAggAAQD1AEsSCRIYOATBJAUFWrgYLwaPF+PFGO8uiqQqua3rYKCKMUbyeI2xhxYYLwbvdzEY0h0lq27h2nXb8lgpXhUj7wCkwTUAaDgKSEtBV7eHnIuK001ujDjnXFQo5hhZ+B1kzISmCKc6HQjN2oTdWEJLhZEMmUEh4bJHh4cgk6zMThofSP5C5WAaUZDFgkgGwv3O5ws6qmHHab7Xjfo6qHFYqADbS8/BBQRnU5REmdqRxAEFRF6LG/ZYNAQqw1LtOEIFRtvK5ygp3Rq356UZ52dfW1HYyLJSO2x52TneZl9jT03s0QmWKwHGgXreJwu6dFFLlgV1/WoupKYoAXdVhOcrxsg+OTUBFCMLe0Qptj0r8KotyRJunFXglDUd+/3kWBU5gmYDUSE123wpE+fysItkGgLjhjykYIWgoCMEFARQH+3uUlEAfQenpyxBVtbveD1bCm50VEbxAcSHZ+D9ieoQxjiKSpLV5UERNM2n7aqhK+O0noiiM8RES8c5iMBcA/qxpq8m77t5QlRKEEkPfrWlEQyPaVFjNBcXSwZZJX/tBmnd/sy9xuqn1SOz9enrAwWk/d2WEh2jzZLrlhPmZRngbB04xGYM9uO9ht0RKxoiSbYhyrBczNFhg6665+JytPoWjP9Kur+ZzR122GIse9kd9kxT9ZPG9x8Y2M2Z885j7Jpr1eIWA3Uxvs3AuG1frMpuTfDPv/x2xiRkhOCRMRqYGb+2V4PgRJO8MfopOn7wBUmKccG7whHmqB4LLIg+D3Xi8WnPv4URLm3x9jmsAj1BjFDrUBsyAb7UBQd5b2jna43J+jXkM2zUCDOsJWgf+cWH8pMCd7jnTnTXtQ6lDezwC3AM484XjLB5Z2BxgwO35Ta2FfrWKV+JxgrtXErchwQJWqhK1H9Pd8pL5vcBbPod/dRQ1KXHMZKJHrzgRsWzK51uRLg4fFG+rwK9nMctRCk6ZL54uxwZblVuN6KZBYur+34egLkZwhqm6AR1xuq4Dz8w3i4esP6AKQKLh4AJItyIEWPQnQoCcAsQyRoMG2hjYBAnW3BegAbQ7AYu0KZ/NNDaGAiUohJmQaVAB+gaGKBj+F3Unv8QUcVFkAQH7myRjVfwBycvNHiHQshnx1hMztqojzX8BGr5gtZ8jlYUBgRjIue3oub5lx0k+SVDBQYED3CD5P2CQCUZAtCSGd+6/BZAywaCBEIJ5AVYwWfvp7YkBGUQJpgjADykgJNGBKp6I+DOb4cMHwEDr7yCBAvH9CUmmfGzLEYaHDyAuaxV/cpfICiljQugN08gnjWgux9w6FngAFAIILh/ZyRKe8JxAgcNLnAPYBYdeMIUEioERuYRoqPskSgEBAUKkIgDO4UO2llIIJHhYGmgmehfI4xExDgTA/wCArxSCgyCHdjFWrfr4SQJICa+JwwmqRQIg8f4VLpJoAEMSAF4DjbEDYsF",
    expected:
      "AgIAAAICDg4WFhUVEhIcHC0tFhYuLkFBJCQ4OFZWJydNTW5uLi5bW4CANjZjY5qaOzt1daioPz+CgsHBS0uTk9jYVFScnO/vWFioqP//YmK4uBISZGTMzC0tbGzT00FBDQ0ZGSEhFhYkJDg4Hx80NFFRISFBQWhoLCxVVXl5Ly9eXoqKOztxcaamQ0N/f7i4RkaHh8/PT0+Wlt7eVVWjo/X1Wlqzsw8PZGTBwSUlZmbS0jg4c3Pd3UlJenro6GBgGhozM0VFIiI8PFtbJiZPT3NzMTFbW4SEMjJoaJubOTl4eK6uQECEhMLCS0uVldraVVWfn+7uWFiysgEBZGS+vhwcZWXHxykpbW3Y2EVFeHjk5FpaeHjx8W1thoYFBYWFJSVHR2lpMDBQUHh4Ly9lZZSUOTlubqqqRUWBgby8RESIiM/PTEydneXlWFikpPv7Xl6zsxMTY2PCwiMjZ2fOzjY2dXXh4UtLdnbx8Wdng4P6+nl5hYUICI2Ni4sXF5+fMzNZWYSEOjpqap+fQEB5ea+vQkKDg8XFSEiWlt7eVFSfn+7uWlqzswoKX1+8vBgYZmbLyzQ0cnLd3UNDcnLr61pafHz09HJyhIQBAYGBiooSEpqalJQdHaqql5cwMMbGPz9xcaenQUF8fL6+SUmKitLSUlKamufnV1eoqAEBXV27uxISYmLIyCQkaWnU1D8/cnLl5VNTenrx8WhofX37+3p6hYUICJOTjIwcHKSkmpopKbm5nZ06Os7OoaFCQuTkSkqEhMfHS0uTk+DgUVGnp/DwWFi1tQwMYmK8vCAgZmbS0jQ0dHTZ2UpKdXXu7ltbe3v6+nNzgoIJCYuLiYkUFJ+fkZEjI7GxmZkwMMXFpKQ9PdfXrKxISPDwsrJdXQICUFCiounpVlawsAQEXV22thQUaWnIyCoqaWnV1T8/dXXl5VJSfX3u7mpqgIACAn9/jY0ODpCQjo4dHaiolpYmJry8m5s3N9PTpqZHR+XlqqpVVf39sbFfXxMTu7tubiMjYGCxsQ4OX1++viUlbm7T0zc3dHTf30xMdHTq6mBggoL9/XZ2h4cGBoqKjo4SEqGhkJAkJLe3n58wMMbGoaFDQ9/fqqpOTvT0tLRgYAYGtbVoaB0dvLx2djExx8eDg0lJY2PJyS4ucnLb20JCdXXo6FZWf3/09GpqgIAGBoGBh4cODpKSkJAbG62tm5ssLMLCm5s5OdLSpKRKSuzsr69UVPv7srJiYhgYublubioqwMCCgkFBx8eMjFRU0dGgoGpqdnbf30pKe3vu7mRkg4P+/nR0hoYJCZGRkJAWFqSkl5cjI7u7n580NMvLoKBERODgqqpNTfX1tbViYgkJt7dwcBwcv793dzk5xcWLi0xM0dGZmVxc0tKionZ23Ny2to2NgID3929vg4MEBIiIjo4REZyclZUjI6+vmpoxMcXFpKQ/P9raq6tKSvHxra1ZWQQEtLRmZhUVv79zcygoxcWFhT4+y8uRkVZW0NCdnWtr1NSuroKC3d2+vpaW5+fLy6en",
  },
  {
    name: "u2 4 lossless",
    shape: [12, 16, 4],
    dtype: "uint16",
    encoded:
      "AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAJanhsbAoAAAXTanhsY/8KWDD8CH4AKFoECAAQAOkGSxIJEhg4BMEkBQVaYAxeMwZljHlRx6Ok2La2W6N2q1IXqcbYQwsZg5ExY1DGGGNmzBhjTF4e40lV27o27LotI6WMZYzlAcgQUwDoZjT0kGPPGHM8hcSz4WWScq4pp1BXnn+HQbSMNcRMWbgqLXQcwxsE4mapAqHVOSUs6kkKKhzYojlUiYO3N18siDrixSAeEIuHzY0IGMtMgXqqXMRwRl1hntoMkCUTbHbhQGixc1suFUwNKLCyspMIVllLntHuHFSl3iBpNN1jkooEWcX+u8XxGzNZXhOLjL4ObUT9Zd38LVWjqaRZocI1DQKbN0JFGjM0Fg3MugbP+lsFg5kcnyBxtk2LL1hj19pSUERnhGM/Xlj8UF2rx67VnIh/xe4pc87acWGNUCVWST5LmIQ2hY2FoHVQoW3mfOZRRAV2EmXljPRTioPZYms0Eo/tqGTNq5yxuOkl6gCT6ARJnm3aeqgawZ5YTYEEifdub5DTFMdsMNcaYreoaFc6LKUglw05UI+h/6UyFxcEKomSRYIhj9WdfvTMK2nSiEAdOERAG+dAQbrlAFlU2z/h1Htyc17Uhiv/RCGy0dJ7I+w0WKkmIqGPK/eTaODylI/WZgQn9tDWSEiMPnCpMen5cUAszeFlbDZN1X1xDD+HHNsLUkSV9mYMfxFVTGSFDTJkZlXaxgwz9HtOcPAXnGDQ0v0HGiAtFzFHhFqCBpuoEKmYn47NPxAixqpgdRuI/MogfvmTZzHkhKhBHJLfaSz8BnIT+2OvIHxq2P5j7M2qsuwwl0mYeY1EvwCSpMeCBXPBGRbE+LN6Db6LvOF+87OR9ve38wdyNEPGtZQMF3xOlo3Cboe11w8uMO/ZiocrTbLCEDHSawtmeFmCW/QZ0sm9wgT6a0vnBNV+IEL/uAbDG5jl7h3hPFuqwHHPFhqDzB/IcIbVuL//O/ZaRv/oOvROlyScEiiQDjARL5COjxHVgt5LjxOpH8kJOiOzFlLG/IkAVe1whCVjn1ynOjUF3wuG4BSoTfBB4WkhQuBP1AzhQ2vhTgz8/wRUREQOQaBGPvULloKY3+/gpEoj4/xCELVFWPqDvYJFgtF2r4pfYJUuRfaEHPQRYL2AgBEc/hRR+kCBNkpolQL9mMJ+fUV4jVGi+UQds5AvufLf8TPoKpgGl1B4xZIKwbdPuxBKKmgQUELUZRswqIcSDCCAjhVotG2S8Egfsh0AJSNgGYR9LqgaBaVSE6Qq+r/GbwQ8tYBWSpCwIBET5TQQoJ3SPwUIg07ONwnK4yMWjiwMqoPvFQGHewYaQIUfL2kkB+7Dg4PcB6AZqCbCiSGmFEgqoAQq+wgEcHEDAwVEK2mhBAkDNEPBQaLS3s/zUGEDGgAy9T2QyIIiQHBAWBUZcuwYHfvd1BaDngQsV6A+gSab5IrozoJvQzECFpThJojoD9APKNtfSH/gQIALFNMXlpAgBqmmhs9A1xwCFQnJv7eNeagjf2cY+FhGjNe/AeHAQbW3j3UEA1M/IXEPHsuirMNSTR88e6sY92hU1CKvCC+Fi7H2m+CRavstQhCKAbT2z8AOzz725KBvEVGImGmNKCKyDy9ssJBNskUogQVblI57vdxW2gxEQUF6Z3JfOT6LMIvjVtCcHG1O2/NcFuoYBwWcGKyK8uCu1MrO701EWmpljaneIT8s1zlREfilJr4z0ZADf/R9HZQZMlqPJlgbD/8mmlMcwKOKCHpHTOzcQqLIMyDwcAEENiUi73Y0QKAjYOkzAKa+FUUJPUQQfEkleVpZDCVNY8ZPt9U2wHybQx5adExEHfMkpJkhy8hjB700dNqe5i6+AFkR69HwURMOOrjsBzw8G+CmVoZa0r1iKGH8xSlf2rzMWAikiG/b7BE3/w5xQNQk5KZHZ5JMk9+OyVH82puHrgkD/hP6bu5AICVVEfhj/XDK5MCnEUDu4zEOwAArWgU+AgI=",
    expected:
      "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",
  },
  {
    name: "f4 1 lossless",
    shape: [12, 16],
    dtype: "float32",
    encoded:
      "AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAJanhsbAoAAAJNanhsY/8KWDByQNEiCAABANwISxLFggVSoPMY3MfISEZGRjJGSqRr2y3q2qLIyMjIGGO8GC8Grzds/wQApxyCgYEoH1883gP6+aGhIczLp9ZBQAAGBuUqMDDAwQEEBEL6NDPDwAAFBQwMULUxMEBBAfhxh/8/CAg6VA8BAcUeltkYUp0NtX6brTQzw/b9v92wi85V2ZVTqdFZtIvNQEFCQoDdgn+SQzwKCo5BYNIDwFaxgn+BAQJYZhYWukSPS8aRqw13ICDg2JhA62AXPCIkn6GggAjHYATFxBgYNMA4hiEgyI4WwsSLw7IroosSfMGai7eePZ93BjAFwsouTRex88bxWHnDPwcEBCAgQI1Eh6wzG2uDFhaBJ/q/6GQpIaEc7FhPI2BZOKUhHAQEjEhgO2baQlkrgFTsUL0ZmWPYqTdTWQgIWG8ZGPStKdSyrGxqmzk956uhV9kXVKvl4IC8i+FZYgM8wokoOSVJSGhgQJKdMb95DncOGBgIAomAgISE/eIcHGSFgYBgFNDHRM67nA1JNIshnK7gIi6xcU5x3wn+635Qcl7O0yu3Yp2Jh4AUExsYIA0v1hAOw8CgHuBU4MBCdIXlFfaySNS1KJqhLEOxothyZPLytll9R9Ci5jY3SEGBsDGe/4tECgoC4tjQcBy+buAgbrqY+Z4mJZcV50DpoNIlBgxKSktwCpJVMSrUIYzBjlFSef3wvZFbfGYDUlDAXwePnEGW/D8YQBgYSEgoIKjPwvkaqg+6rg6lHG7aAJQMDD7kOTgA",
    expected:
      "wcBAPOHg4DyBgIA96ejoPYGAAD6RkBA+wcBAPtnYWD719HQ+/fx8PpeWlj6joqI+t7a2Pr28vD7JyMg+3dzcPsHAQD2RkJA96ejoPYWEBD6dnBw+2dhYPvX0dD75+Hg+l5aWPqWkpD6lpKQ+tbS0Ps/Ozj7Pzs4+4+LiPvHw8D7Z2Ng9jYwMPqmoKD69vDw+4eBgPvn4eD6DgoI+n56ePqOioj67uro+x8bGPtXU1D7j4uI+8/LyPoGAAD+FhAQ/hYQEPsHAQD7V1FQ+8fBwPoOCgj6Pjo4+oaCgPquqqj6zsrI+y8rKPt3c3D7d3Nw+7ezsPoWEBD+Ligo/i4oKP8nISD7l5GQ+6ehoPomIiD6XlpY+r66uPrOysj7DwsI+ycjIPuXk5D7v7u4++fj4PomICD+Ligo/lJMTP5uaGj/19HQ+/fx8PpGQkD6bmpo+sbCwPre2tj7R0NA+19bWPt/e3j7t7Ow+goEBP4iHBz+Pjg4/lpUVP6GgID+ioSE/k5KSPpWUlD6pqKg+sbCwPr28vD7T0tI+5eTkPuno6D75+Pg+h4YGP4+ODj+Ylxc/m5oaP6WkJD+sqys/sbAwP6GgoD63trY+ubi4Ps/Ozj7h4OA+5+bmPvn4+D6BgAA/hoUFP46NDT+ZmBg/o6IiP6SjIz+sqys/tbQ0P7i3Nz+9vLw+z87OPtva2j7d3Nw+8/LyPoOCAj+GhQU/kpERP5mYGD+cmxs/oJ8fP6uqKj+trCw/ubg4P7++Pj/HxkY/zczMPtnY2D7p6Og++fj4PoaFBT+HhgY/lpUVP5qZGT+hoCA/p6YmP6+uLj+5uDg/u7o6P7++Pj/Ix0c/zs1NP+Xk5D7v7u4++/r6PomICD+NjAw/k5ISP5ybGz+gnx8/p6YmP7KxMT+8uzs/wL8/P8PCQj/R0FA/1NNTP97dXT/5+Pg+g4ICP5CPDz+Pjg4/nZwcP6CfHz+pqCg/sK8vP7i3Nz/Avz8/xMNDP8/OTj/V1FQ/29paP9zbWz/l5GQ/",
  },
  {
    name: "f4 3 lossless",
    shape: [12, 16, 3],
    dtype: "float32",
    encoded:
      "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",
    expected:
      "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",
  },
  {
    name: "f4 4 lossless",
    shape: [12, 16, 4],
    dtype: "float32",
    encoded:
      "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",
    expected:
      "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",
  },
];

// `distance=1.0`, so XYB-encoded, whose samples jxl-oxide renders a few levels
// from what libjxl does.
const LOSSY =
  "/wpYMJAUNwIAEwgBALgBZxMoAQBQoTLKuMHLuZ4vP3RYTNu4ztBW2xaWJIqMY5N0AocksQLiboA7AJCgmBfOWRkGeIAiqJACeTAUGxnFyBijYlQUIzkZGVcyLBuZ83A+/TDqmN8wgyuBKgIlrs2K/GXIRaNEzWN2am+aoG4=";

const decodeAs = (encoded: string, dataType: keyof typeof DATA_TYPES) =>
  decompressJxlSamples(
    fromBase64(encoded),
    dataType === "uint8" ? 1 : dataType === "uint16" ? 2 : 4,
    dataType === "float32",
  );

test("decodes what libjxl decodes, of 1, 3 and 4 components", async () => {
  for (const { shape, dtype, encoded, expected } of CASES) {
    const dataType = DATA_TYPES[dtype as keyof typeof DATA_TYPES];
    const decoded = jxlChunkArray(
      dataType,
      [1, ...shape],
      await decodeAs(encoded, dtype as keyof typeof DATA_TYPES),
    );
    const bytes = fromBase64(expected);
    expect(
      new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength),
    ).toEqual(bytes);
    // Encoder settings in the configuration are ignored.
    parseCodecChainSpec(
      [{ name: "imagecodecs_jpegxl", configuration: { level: 100 } }],
      { dataType, chunkShape: shape },
    );
  }
});

test("the wasm still decodes 8-bit images for the precomputed data source", async () => {
  const { shape, encoded, expected } = {
    shape: [12, 16],
    encoded:
      "/wpYMBAUNwIIAAEA4AFLEsWCBVIgobYtyHREdAzd8cJMACjaoq7GGn6IvAFWwnesNhPomqlQpSjM5VfFEQQOlw4gTII1upibgYQ491I5V/hpVHkESlzzrjHv5QafQEUEA8x4mNbUMVEZHKjKydpBECbankxMBCxITJPkx9rRHZobBZcFqA4=",
    expected:
      "BAoRGCQmLzQ7QUhUWl5mcBIZGiUpMzxBS01VWmZscHgeJSkxOTpDR1FZXWhqeH6FITA2OUNETFhhaG9vfIKDizI6PkJLUVhhanByfYGJlJY4QElPW1tland6gYWTmJmiRkxWXmNrbHt9iYuUmZ2qrU9bW2VrcXeDiZKbnKGrtb5eYWxxeIKJipefo6WttMLJZ3B2eYeMkZydo6+0uMTJ0HB3foWNlaCkqbS1vcXQ1td9gI+Pm6Spsbm5w83V29/l",
  };
  const decoded = await decompressJxl(
    fromBase64(encoded),
    shape[0] * shape[1],
    1,
    1,
  );
  expect(decoded.uint8Array).toEqual(fromBase64(expected));
});

test("rejects other data types", () => {
  expect(() =>
    parseCodecChainSpec([{ name: "imagecodecs_jpegxl" }], {
      dataType: DataType.INT16,
      chunkShape: [2, 2],
    }),
  ).toThrow(/supports the uint8, uint16 and float32 data types, not int16/);
});

test("rejects lossy images", async () => {
  await expect(decodeAs(LOSSY, "uint8")).rejects.toThrow(
    /lossy images are not supported/,
  );
});

test("rejects samples of another type", async () => {
  await expect(
    decodeAs(
      "AAAADEpYTCANCocKAAAAFGZ0eXBqeGwgAAAAAGp4bCAAAAAJanhsbAoAAAFdanhsY/8KWDD8AEWLCAABABwFSxLFggVSYKNi8MyoGCRJjIyuBLu2HVqcgvUBAEQ7BQQWKriud8DAQgOuHwooIIBAQvJvAgwIJFRHDQYYJvc8DKcpOpzqlBtmdyKJJeerREJ2MAkDzD/PyRUQR1E1AUpE5m2w4L2NR4ySjFzTidobW0IDWgV74HY7Dp05LQeMDVCQfRn2C0GPwjL8qXjAZHuikBH4kMr248QgAq1KOylwdnjLgJKDBvdwK61mhaWjJy4ewWCkxYGBK9Jumi8rg1IEgQmJQlAKFLsAgRs/JKoCThUYoPtX6vwIh5T6kGs1AK1UIAIipMJgc8eaT7g4CgRTUUBLqNRSwqMtGCT1y4FIkgTGR8BboWmH22ueHgJZbiRMTDFAkOs3t5AAAgaW3P5BwrvGEqPAR7QMFKoZx0zqDQIFro478kPAmQOgoM1H+kkzAF2i57kH",
      "uint8",
    ),
  ).rejects.toThrow(/image of 16-bit integer samples is not uint8/);
});

test("rejects unsupported sample sizes", async () => {
  await expect(
    decompressJxlSamples(new Uint8Array(16), 3, false),
  ).rejects.toThrow(/unsupported samples of 3 bytes, integer/);
});

test("rejects a truncated stream", async () => {
  const { encoded, dtype } = CASES[0];
  const stream = fromBase64(encoded);
  await expect(
    decompressJxlSamples(
      stream.subarray(0, stream.length >> 1),
      dtype === "uint8" ? 1 : 2,
      false,
    ),
  ).rejects.toThrow(/Decoding failed/);
});

test("rejects an image that does not fill the chunk", () => {
  const decoded = {
    width: 4,
    height: 2,
    numComponents: 3,
    data: new Uint8Array(24),
  };
  expect(() => jxlChunkArray(DataType.UINT8, [2, 4], decoded)).toThrow(
    /JPEG XL image of shape \[2, 4, 3\] .* does not fill a chunk/,
  );
});

test("rejects images of 2 components", () => {
  expect(() =>
    jxlChunkArray(DataType.UINT8, [2, 4, 2], {
      width: 4,
      height: 2,
      numComponents: 2,
      data: new Uint8Array(16),
    }),
  ).toThrow(/JPEG XL image of 2 components is not supported/);
});

test("rejects an image of several frames", async () => {
  // A 4-dimensional array, each frame of which `jpegxl_decode` returns.
  await expect(
    decodeAs(
      "/wooMEETAIgJCAABAHADSxLFggVSuOMCAQOwKZEA2Jysbb2DIRK92i8feqr/oqydYb8eUPCXv1MpjwEHAYu7WyWfzHGqzZu6f6iDNC+31kxWRkHVFe5po9r1QoneBrtyVxfl7LzTLlGkxe1091BD9MLSznaCEPuMWM0MR8YxF54+aYIIZyerHGYLOM1JDsT7koPQni4lvr9fKEoL0F8QyMw6y+UM1SMaX7s7O8CW+rEjMqwGptIfd66KoMJvb6YzHZVFIertGPCoJ/fWysiL/NiLY7cZEbyYrVVgKZiLoUyh1ipmC4xcocOQEggAAQB4A0sSxYIFUrjiAgEDGOwDjRBICwGdqe4+WRgkoYzSMs86i9oG9AmXsp5QmDW7ieHJbRtk4aEDfw4J+0NsDUsn9kiy/tXB/JIu9FSiqZXzSM/jJNWnkTgkRBy6sjah4cqGUXVZaB6AKCUd7XTPLvjcpD1v4pFiCni5bwqsCtWDULlcYYx1Dqkz09H3Ra3s81ZIg6cXut7OS0CCf6LV06Y5EjQQMglV8lz4hqFg19aqvf/iYi8nFeAlWx2F8+pbq4DN1VooIVuwQQlG+oHZC8VNhz+y4hmR9GRicDYVpreiAggABQB8A0sSxYIFUrjjAgEDAGunAHCnNsw0QuO+AdrImB+7g4xluHFMiEvULTnoFD2k7JnUwLG9B3jxGSTT3Ijg2lM9EyKzj54nE9wVi3QtjXBmolDGuLeMYB55fqW13XP1FGRFSChCn6O3ZpYS9fcgvFYhj6Zk5K7lP5rR4eT+nUbbVOT5ro8n6U6e/Wb05Uq0wnZh7i2YvXvgE+1ONihOH53HrrjRrAr02B7xRnKTrugAbyekV941aWTBp+P2dZBM+X1rzcn1pZ/PzEdos2JD/+9DZQk5K9tE1wxOUmdCjarAjAE=",
      "uint8",
    ),
  ).rejects.toThrow(/image of 3 frames, not 1/);
});
