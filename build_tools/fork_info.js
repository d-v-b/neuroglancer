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

// Computes the identity of this fork of Neuroglancer (repository, branch,
// commit and whether the tree was dirty) at build time, for the banner the
// viewer shows so that a fork build is not mistaken for google/neuroglancer.
//
// The result is passed to the client as the `NEUROGLANCER_FORK_INFO` define
// (see rspack.config.ts and src/ui/fork_banner.ts).
//
// Environment overrides, for builds without git or from detached checkouts:
//   NEUROGLANCER_FORK_REPO    `owner/name`, or a git remote URL
//   NEUROGLANCER_FORK_BRANCH  branch name
//   NEUROGLANCER_FORK_COMMIT  commit hash (full or abbreviated)

import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";

/**
 * @typedef {object} GitRemote
 * @property {string} host
 * @property {string} owner
 * @property {string} name
 */

/**
 * @typedef {object} ForkInfo
 * @property {string | null} repo `owner/name`, or null when unknown.
 * @property {string | null} repoUrl
 * @property {string | null} branch Branch name; a detached checkout is
 *     described as `<branch> (detached)` or `detached (<git describe>)`.
 * @property {string | null} commit Abbreviated commit hash.
 * @property {string | null} commitUrl
 * @property {boolean} dirty Whether tracked files differed from the commit.
 */

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Parses a git remote URL into its host, owner and repository name.
 *
 * Accepts the https form (`https://github.com/owner/name[.git]`), the scp-like
 * ssh form (`git@github.com:owner/name[.git]`) and the ssh URL form
 * (`ssh://git@github.com/owner/name[.git]`).
 *
 * @param {string} url
 * @returns {GitRemote}
 */
export function parseGitRemoteUrl(url) {
  const trimmed = url.trim();
  let host;
  let path;
  const scpMatch = /^(?:[^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.*)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid git remote URL: ${JSON.stringify(url)}`);
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      throw new Error(
        `Unsupported git remote URL scheme ${JSON.stringify(parsed.protocol)}: ${JSON.stringify(url)}`,
      );
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scpMatch !== null) {
    host = scpMatch[1];
    path = scpMatch[2];
  } else {
    throw new Error(`Invalid git remote URL: ${JSON.stringify(url)}`);
  }
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || !parts.every((part) => NAME_PATTERN.test(part))) {
    throw new Error(
      `Git remote URL does not name an owner/repository: ${JSON.stringify(url)}`,
    );
  }
  const [owner, name] = parts;
  return { host, owner, name };
}

/**
 * Parses the `NEUROGLANCER_FORK_REPO` override: either `owner/name` (on
 * github.com) or a git remote URL.
 *
 * @param {string} value
 * @returns {GitRemote}
 */
export function parseRepoOverride(value) {
  const parts = value.trim().split("/");
  if (parts.length === 2 && parts.every((part) => NAME_PATTERN.test(part))) {
    return { host: "github.com", owner: parts[0], name: parts[1] };
  }
  return parseGitRemoteUrl(value);
}

/**
 * @param {string} cwd
 * @returns {(...args: string[]) => string | undefined}
 */
function makeGit(cwd) {
  return (...args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
}

/**
 * Describes the checked-out branch, or the detached HEAD.
 *
 * @param {(...args: string[]) => string | undefined} git
 * @returns {string | null}
 */
function describeBranch(git) {
  const branch = git("symbolic-ref", "--short", "-q", "HEAD");
  if (branch) return branch;
  if (git("rev-parse", "--verify", "-q", "HEAD") === undefined) return null;
  // Detached HEAD (as when vzip's js/demo/pages.sh builds a detached
  // checkout): name the origin branch whose tip is HEAD, if there is one.
  const remoteBranches = (
    git(
      "for-each-ref",
      "--points-at",
      "HEAD",
      "--format=%(refname)",
      "refs/remotes/origin",
    ) ?? ""
  )
    .split("\n")
    .map((ref) => ref.replace(/^refs\/remotes\/origin\//, ""))
    .filter((ref) => ref !== "" && ref !== "HEAD");
  if (remoteBranches.length > 0) return `${remoteBranches[0]} (detached)`;
  const description = git("describe", "--tags", "--always");
  return description ? `detached (${description})` : "detached";
}

/**
 * Computes the fork identity from git in `cwd`, with environment overrides.
 * Fields that cannot be determined are null.
 *
 * @param {{cwd?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {ForkInfo}
 */
export function computeForkInfo(options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  const git = makeGit(cwd);

  /** @type {GitRemote | undefined} */
  let remote;
  const repoOverride = env.NEUROGLANCER_FORK_REPO;
  if (repoOverride) {
    remote = parseRepoOverride(repoOverride);
  } else {
    const originUrl = git("remote", "get-url", "origin");
    if (originUrl) {
      try {
        remote = parseGitRemoteUrl(originUrl);
      } catch (error) {
        console.warn(`Neuroglancer fork banner: ${error.message}`);
      }
    }
  }

  const branch = env.NEUROGLANCER_FORK_BRANCH || describeBranch(git);

  const commitOverride = env.NEUROGLANCER_FORK_COMMIT;
  const fullCommit = commitOverride || git("rev-parse", "HEAD") || null;
  const commit =
    fullCommit === null
      ? null
      : commitOverride
        ? commitOverride.slice(0, 12)
        : (git("rev-parse", "--short", "HEAD") ?? fullCommit.slice(0, 7));
  const dirty = commitOverride
    ? false
    : (git("status", "--porcelain", "--untracked-files=no") ?? "") !== "";

  const repoUrl =
    remote === undefined
      ? null
      : `https://${remote.host}/${remote.owner}/${remote.name}`;
  return {
    repo: remote === undefined ? null : `${remote.owner}/${remote.name}`,
    repoUrl,
    branch,
    commit,
    commitUrl:
      repoUrl === null || fullCommit === null
        ? null
        : `${repoUrl}/commit/${fullCommit}`,
    dirty,
  };
}
