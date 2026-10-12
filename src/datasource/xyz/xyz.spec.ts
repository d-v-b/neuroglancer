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

import { describe, expect, it } from "vitest";
import { getXyzTileUrl } from "#src/datasource/xyz/base.js";
import { parseXyzUrl } from "#src/datasource/xyz/url.js";

describe("parseXyzUrl", () => {
  it("parses URL templates and options", () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        "https://tile.example.com/{z}/{x}/{y}.png",
        {
          urlTemplate: "https://tile.example.com/{z}/{x}/{y}.png",
          subdomains: [],
          tileMatrixSet: expect.objectContaining({
            crs: "EPSG:3857",
            tileSize: 256,
            minZoom: 0,
            maxZoom: 18,
            columns0: 1,
            rows0: 1,
            originX: expect.closeTo(-20037508.342789244, 6),
            originY: expect.closeTo(20037508.342789244, 6),
            resolution0: expect.closeTo(156543.03392804097, 6),
          }),
        },
      ],
      [
        "https://{s}.tiles.example.com/wmts/{z}/{y}/{x}.jpg#crs=EPSG:4326&maxzoom=13&tilesize=512",
        {
          urlTemplate: "https://{s}.tiles.example.com/wmts/{z}/{y}/{x}.jpg",
          subdomains: ["a", "b", "c"],
          tileMatrixSet: expect.objectContaining({
            crs: "EPSG:4326",
            tileSize: 512,
            maxZoom: 13,
            columns0: 2,
            rows0: 1,
            originX: -180,
            originY: 90,
            resolution0: 180 / 512,
          }),
        },
      ],
      [
        "https://example.com/{z}/{x}/{-y}.png#crs=EPSG:3413&resolution=8192&origin=-4194304,4194304&subdomains=xy",
        {
          urlTemplate: "https://example.com/{z}/{x}/{-y}.png",
          subdomains: ["x", "y"],
          tileMatrixSet: expect.objectContaining({
            crs: "EPSG:3413",
            originX: -4194304,
            originY: 4194304,
            resolution0: 8192,
          }),
        },
      ],
    ];
    for (const [url, expected] of cases) {
      expect(parseXyzUrl(url), url).toEqual(expect.objectContaining(expected));
    }
  });

  it("substitutes tile coordinates", () => {
    const parameters = {
      urlTemplate: "https://{s}.example.com/{z}/{x}/{y}/{-y}.png",
      zoom: 3,
      tileSize: 256,
      numRows: 8,
      subdomains: ["a", "b"],
    };
    expect(getXyzTileUrl(parameters, 5, 2)).toBe(
      "https://b.example.com/3/5/2/5.png",
    );
  });

  it("rejects templates without tile placeholders", () => {
    expect(() => parseXyzUrl("https://example.com/tiles.png")).toThrow(
      /must contain \{z\}, \{x\}, and \{y\}/,
    );
  });

  it("rejects unsupported options", () => {
    expect(() => parseXyzUrl("https://example.com/{z}/{x}/{y}#foo=1")).toThrow(
      /Unsupported XYZ options: foo/,
    );
  });

  it("rejects invalid zoom ranges", () => {
    expect(() =>
      parseXyzUrl("https://example.com/{z}/{x}/{y}#minzoom=5&maxzoom=2"),
    ).toThrow(/Invalid XYZ zoom range/);
  });

  it("requires an explicit tile matrix for other CRSs", () => {
    expect(() =>
      parseXyzUrl("https://example.com/{z}/{x}/{y}#crs=EPSG:3413"),
    ).toThrow(/require the "resolution" and "origin" options/);
  });
});
