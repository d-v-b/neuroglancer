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

/**
 * @file A thin strip above the viewer naming this fork of Neuroglancer (its
 * repository, branch and commit), so that a build of the fork is not mistaken
 * for google/neuroglancer.
 */

import "#src/ui/fork_banner.css";

/**
 * Identity of the fork, computed at build time by build_tools/fork_info.js.
 * Unknown fields are null.
 */
export interface ForkInfo {
  repo: string | null;
  repoUrl: string | null;
  branch: string | null;
  commit: string | null;
  commitUrl: string | null;
  dirty: boolean;
}

declare let NEUROGLANCER_FORK_INFO: ForkInfo | undefined;

export const UPSTREAM_REPO = "google/neuroglancer";

const UNKNOWN_FORK_INFO: ForkInfo = {
  repo: null,
  repoUrl: null,
  branch: null,
  commit: null,
  commitUrl: null,
  dirty: false,
};

/**
 * Returns the fork identity defined at build time, or all-unknown fields when
 * the client was built without it (for example, by a project that bundles
 * Neuroglancer as a package).
 */
export function getForkInfo(): ForkInfo {
  return typeof NEUROGLANCER_FORK_INFO !== "undefined"
    ? { ...UNKNOWN_FORK_INFO, ...NEUROGLANCER_FORK_INFO }
    : UNKNOWN_FORK_INFO;
}

function makeLink(text: string, url: string | null, className: string) {
  const element = document.createElement(url === null ? "span" : "a");
  element.classList.add(className);
  element.textContent = text;
  if (element instanceof HTMLAnchorElement && url !== null) {
    element.href = url;
    element.target = "_blank";
    element.rel = "noopener noreferrer";
  }
  return element;
}

/**
 * Appends `<repo> · <branch> @ <commit>[-dirty]` to `parent`, with the
 * repository and the commit linked to their pages when known.
 */
export function appendForkIdentity(parent: HTMLElement, info: ForkInfo) {
  parent.append(
    makeLink(
      info.repo ?? "unknown repo",
      info.repoUrl,
      "neuroglancer-fork-repo",
    ),
    ` · ${info.branch ?? "unknown branch"} @ `,
    makeLink(
      info.commit ?? "unknown commit",
      info.commitUrl,
      "neuroglancer-fork-commit",
    ),
  );
  if (info.dirty) {
    const dirty = document.createElement("span");
    dirty.classList.add("neuroglancer-fork-dirty");
    dirty.textContent = "-dirty";
    dirty.title = "Built from a tree with uncommitted changes";
    parent.append(dirty);
  }
}

export function forkSummary(info: ForkInfo) {
  return (
    `Neuroglancer fork: ${info.repo ?? "unknown repo"} · ` +
    `${info.branch ?? "unknown branch"} @ ${info.commit ?? "unknown commit"}` +
    `${info.dirty ? "-dirty" : ""} (not ${UPSTREAM_REPO})`
  );
}

export function makeForkBanner(info: ForkInfo = getForkInfo()) {
  const banner = document.createElement("div");
  banner.classList.add("neuroglancer-fork-banner");
  banner.setAttribute("role", "note");
  banner.title = forkSummary(info);
  const label = document.createElement("span");
  label.classList.add("neuroglancer-fork-label");
  label.textContent = "Neuroglancer fork: ";
  banner.append(label);
  appendForkIdentity(banner, info);
  const upstream = document.createElement("span");
  upstream.classList.add("neuroglancer-fork-upstream");
  upstream.textContent = ` (not ${UPSTREAM_REPO})`;
  banner.append(upstream);
  return banner;
}

/**
 * Inserts the banner just before the viewer's container, which takes the
 * remaining height (see default_viewer.css), so the banner covers nothing.
 * Returns a function that removes it.
 */
export function insertForkBanner(
  container: HTMLElement,
  info: ForkInfo = getForkInfo(),
) {
  const banner = makeForkBanner(info);
  const parent = container.parentElement ?? document.body;
  parent.insertBefore(
    banner,
    container.parentElement === null ? parent.firstChild : container,
  );
  return () => banner.remove();
}
