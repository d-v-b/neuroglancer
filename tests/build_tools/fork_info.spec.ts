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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  computeForkInfo,
  parseGitRemoteUrl,
  parseRepoOverride,
} from "../../build_tools/fork_info.js";

describe("parseGitRemoteUrl", () => {
  test.each([
    ["https://github.com/d-v-b/neuroglancer.git", "github.com"],
    ["https://github.com/d-v-b/neuroglancer", "github.com"],
    ["https://github.com/d-v-b/neuroglancer/", "github.com"],
    ["https://user@github.com/d-v-b/neuroglancer.git", "github.com"],
    ["git@github.com:d-v-b/neuroglancer.git", "github.com"],
    ["git@github.com:d-v-b/neuroglancer", "github.com"],
    ["ssh://git@github.com/d-v-b/neuroglancer.git", "github.com"],
    ["ssh://git@github.com:22/d-v-b/neuroglancer", "github.com"],
    [
      "  https://gitlab.example.org/d-v-b/neuroglancer.git\n",
      "gitlab.example.org",
    ],
  ])("%j", (url, host) => {
    expect(parseGitRemoteUrl(url)).toEqual({
      host,
      owner: "d-v-b",
      name: "neuroglancer",
    });
  });

  test("rejects a string that is not a remote URL", () => {
    expect(() => parseGitRemoteUrl("d-v-b/neuroglancer")).toThrow(
      /Invalid git remote URL/,
    );
  });

  test("rejects a URL that cannot be parsed", () => {
    expect(() => parseGitRemoteUrl("https://")).toThrow(
      /Invalid git remote URL/,
    );
  });

  test("rejects an unsupported scheme", () => {
    expect(() =>
      parseGitRemoteUrl("file:///srv/git/d-v-b/neuroglancer.git"),
    ).toThrow(/Unsupported git remote URL scheme/);
  });

  test("rejects a path that does not name an owner and repository", () => {
    expect(() => parseGitRemoteUrl("https://github.com/d-v-b")).toThrow(
      /does not name an owner\/repository/,
    );
  });
});

describe("parseRepoOverride", () => {
  test.each([
    ["d-v-b/neuroglancer", "github.com"],
    ["git@github.com:d-v-b/neuroglancer.git", "github.com"],
    ["https://gitlab.example.org/d-v-b/neuroglancer", "gitlab.example.org"],
  ])("%j", (value, host) => {
    expect(parseRepoOverride(value)).toEqual({
      host,
      owner: "d-v-b",
      name: "neuroglancer",
    });
  });

  test("rejects a value that is neither owner/name nor a remote URL", () => {
    expect(() => parseRepoOverride("neuroglancer")).toThrow(
      /Invalid git remote URL/,
    );
  });
});

describe("computeForkInfo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ng-fork-info-"));
    dirs.push(dir);
    return dir;
  }

  function makeRepo() {
    const dir = makeDir();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
    git("init", "-q", "-b", "vzip");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("remote", "add", "origin", "git@github.com:d-v-b/neuroglancer.git");
    fs.writeFileSync(path.join(dir, "file.txt"), "a\n");
    git("add", "file.txt");
    git("commit", "-q", "-m", "initial");
    const commit = git("rev-parse", "HEAD");
    const short = git("rev-parse", "--short", "HEAD");
    return { dir, git, commit, short };
  }

  test("reads git, then applies overrides", () => {
    const { dir, git, commit, short } = makeRepo();
    const repoUrl = "https://github.com/d-v-b/neuroglancer";
    const expected = {
      repo: "d-v-b/neuroglancer",
      repoUrl,
      branch: "vzip",
      commit: short,
      commitUrl: `${repoUrl}/commit/${commit}`,
      dirty: false,
    };

    // On a branch, clean.
    expect(computeForkInfo({ cwd: dir, env: {} })).toEqual(expected);

    // A modified tracked file makes the tree dirty.
    fs.writeFileSync(path.join(dir, "file.txt"), "b\n");
    expect(computeForkInfo({ cwd: dir, env: {} })).toEqual({
      ...expected,
      dirty: true,
    });
    git("checkout", "-q", "file.txt");

    // Detached at the tip of an origin branch.
    git("update-ref", "refs/remotes/origin/vzip", commit);
    git("checkout", "-q", "--detach");
    expect(computeForkInfo({ cwd: dir, env: {} })).toEqual({
      ...expected,
      branch: "vzip (detached)",
    });

    // Detached elsewhere: described by `git describe`.
    git("update-ref", "-d", "refs/remotes/origin/vzip");
    expect(computeForkInfo({ cwd: dir, env: {} })).toEqual({
      ...expected,
      branch: `detached (${short})`,
    });

    // Environment overrides.
    expect(
      computeForkInfo({
        cwd: dir,
        env: {
          NEUROGLANCER_FORK_REPO: "someone/neuroglancer",
          NEUROGLANCER_FORK_BRANCH: "main",
          NEUROGLANCER_FORK_COMMIT: "0123456789abcdef0123",
        },
      }),
    ).toEqual({
      repo: "someone/neuroglancer",
      repoUrl: "https://github.com/someone/neuroglancer",
      branch: "main",
      commit: "0123456789ab",
      commitUrl:
        "https://github.com/someone/neuroglancer/commit/0123456789abcdef0123",
      dirty: false,
    });

    // Without git, every field is unknown unless overridden.
    const plain = makeDir();
    expect(computeForkInfo({ cwd: plain, env: {} })).toEqual({
      repo: null,
      repoUrl: null,
      branch: null,
      commit: null,
      commitUrl: null,
      dirty: false,
    });
    expect(
      computeForkInfo({
        cwd: plain,
        env: { NEUROGLANCER_FORK_REPO: "d-v-b/neuroglancer" },
      }),
    ).toEqual({
      repo: "d-v-b/neuroglancer",
      repoUrl,
      branch: null,
      commit: null,
      commitUrl: null,
      dirty: false,
    });
  });

  test("rejects an invalid NEUROGLANCER_FORK_REPO", () => {
    expect(() =>
      computeForkInfo({
        cwd: makeDir(),
        env: { NEUROGLANCER_FORK_REPO: "not a repo" },
      }),
    ).toThrow(/Invalid git remote URL/);
  });
});
