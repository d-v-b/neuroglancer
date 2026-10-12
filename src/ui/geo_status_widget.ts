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
 * @file Top-bar widget showing the geographic coordinates under the mouse (or at the center of the
 * view) and allowing the display CRS to be changed.
 */

import "#src/ui/geo_status_widget.css";
import { COMMON_DISPLAY_CRS_LIST } from "#src/geo/crs.js";
import type { GeoViewState } from "#src/geo/geo_view.js";
import { formatLatitudeLongitude, globalToLonLat } from "#src/geo/geo_view.js";
import type { MouseSelectionState } from "#src/layer/index.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";

let nextDatalistId = 0;

export class GeoStatusWidget extends RefCounted {
  element = document.createElement("div");
  private coordinatesElement = document.createElement("span");
  private crsInput = document.createElement("input");

  constructor(
    public geoView: GeoViewState,
    public mouseState: MouseSelectionState,
  ) {
    super();
    const { element, coordinatesElement, crsInput } = this;
    element.className = "neuroglancer-geo-status";
    coordinatesElement.className = "neuroglancer-geo-status-coordinates";
    coordinatesElement.title =
      "Geographic (WGS 84) coordinates of the mouse position, or of the center of the view";
    crsInput.className = "neuroglancer-geo-status-crs";
    crsInput.spellcheck = false;
    crsInput.title =
      "Display coordinate reference system.  Enter an EPSG code (e.g. EPSG:3857) or a proj4 definition.";
    const datalist = document.createElement("datalist");
    datalist.id = `neuroglancer-geo-crs-list-${nextDatalistId++}`;
    for (const { id, description } of COMMON_DISPLAY_CRS_LIST) {
      const option = document.createElement("option");
      option.value = id;
      option.label = description;
      datalist.appendChild(option);
    }
    crsInput.setAttribute("list", datalist.id);
    crsInput.addEventListener("change", () => this.applyCrsInput());
    crsInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.applyCrsInput();
        crsInput.blur();
      } else if (event.key === "Escape") {
        this.updateView();
        crsInput.blur();
      }
      event.stopPropagation();
    });
    crsInput.addEventListener("focus", () => {
      // Show all options in the datalist.
      crsInput.select();
    });
    element.appendChild(coordinatesElement);
    element.appendChild(crsInput);
    element.appendChild(datalist);
    const update = this.registerCancellable(
      animationFrameDebounce(() => this.updateView()),
    );
    this.registerDisposer(geoView.changed.add(update));
    this.registerDisposer(mouseState.changed.add(update));
    this.registerDisposer(geoView.navigationState.position.changed.add(update));
    this.updateView();
  }

  private applyCrsInput() {
    const { crsInput } = this;
    const value = crsInput.value.trim();
    if (value === "" || value === this.geoView.displayCrs.value) {
      this.updateView();
      return;
    }
    try {
      this.geoView.setDisplayCrs(value);
      crsInput.classList.remove("neuroglancer-geo-status-crs-invalid");
      crsInput.title = this.geoView.displayCrs.value ?? "";
    } catch (e) {
      crsInput.classList.add("neuroglancer-geo-status-crs-invalid");
      crsInput.title = (e as Error).message;
    }
  }

  private updateView() {
    const { geoView, element } = this;
    const crs = geoView.displayCrs.value;
    element.hidden = crs === undefined;
    if (crs === undefined) return;
    if (document.activeElement !== this.crsInput) {
      this.crsInput.value = crs;
    }
    const info = geoView.info;
    let text = "";
    if (info !== undefined) {
      const { mouseState } = this;
      const lonLat = new Float64Array(2);
      let valid = false;
      if (
        mouseState.active &&
        mouseState.coordinateSpace === geoView.coordinateSpace.value
      ) {
        valid = globalToLonLat(info, mouseState.position, lonLat);
      } else {
        const center = geoView.getCenterLonLat();
        if (center !== undefined) {
          lonLat.set(center);
          valid = true;
        }
      }
      if (valid) {
        text = `${formatLatitudeLongitude(lonLat[1], true)} ${formatLatitudeLongitude(lonLat[0], false)}`;
      }
    }
    this.coordinatesElement.textContent = text;
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
