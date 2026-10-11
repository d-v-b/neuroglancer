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
import type { ForkInfo } from "#src/ui/fork_banner.js";
import {
  getForkInfo,
  insertForkBanner,
  makeForkBanner,
} from "#src/ui/fork_banner.js";

const REPO_URL = "https://github.com/d-v-b/neuroglancer";
const COMMIT_URL = `${REPO_URL}/commit/2e3c79900000000000000000000000000000000`;

const KNOWN: ForkInfo = {
  repo: "d-v-b/neuroglancer",
  repoUrl: REPO_URL,
  branch: "vzip",
  commit: "2e3c799",
  commitUrl: COMMIT_URL,
  dirty: false,
};

const UNKNOWN: ForkInfo = {
  repo: null,
  repoUrl: null,
  branch: null,
  commit: null,
  commitUrl: null,
  dirty: false,
};

describe("makeForkBanner", () => {
  test.each([
    {
      info: KNOWN,
      text: "Neuroglancer fork: d-v-b/neuroglancer · vzip @ 2e3c799 (not google/neuroglancer)",
      links: [
        ["d-v-b/neuroglancer", REPO_URL],
        ["2e3c799", COMMIT_URL],
      ],
    },
    {
      info: { ...KNOWN, dirty: true },
      text: "Neuroglancer fork: d-v-b/neuroglancer · vzip @ 2e3c799-dirty (not google/neuroglancer)",
      links: [
        ["d-v-b/neuroglancer", REPO_URL],
        ["2e3c799", COMMIT_URL],
      ],
    },
    {
      info: UNKNOWN,
      text: "Neuroglancer fork: unknown repo · unknown branch @ unknown commit (not google/neuroglancer)",
      links: [],
    },
  ])("$text", ({ info, text, links }) => {
    const banner = makeForkBanner(info);
    expect(banner.classList.contains("neuroglancer-fork-banner")).toBe(true);
    expect(banner.textContent).toBe(text);
    expect(banner.title).toBe(text);
    expect(
      Array.from(banner.querySelectorAll("a"), (a) => [a.textContent, a.href]),
    ).toEqual(links);
  });
});

test("getForkInfo is all-unknown without the build-time define", () => {
  expect(getForkInfo()).toEqual(UNKNOWN);
});

test("insertForkBanner places the banner before the container", () => {
  const parent = document.createElement("div");
  const container = document.createElement("div");
  parent.appendChild(container);
  const remove = insertForkBanner(container, KNOWN);
  expect(
    parent.firstElementChild?.classList.contains("neuroglancer-fork-banner"),
  ).toBe(true);
  expect(parent.lastElementChild).toBe(container);
  remove();
  expect(parent.children.length).toBe(1);
});
