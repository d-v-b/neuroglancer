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
 * @file Backend of `GlobeVolumeRenderLayer`: requests the chunks of the tiles shown on the globe
 * (see `src/sliceview/globe.ts`).
 */

import { withChunkManager } from "#src/chunk_manager/backend.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import { WGS84_SEMI_MINOR_AXIS } from "#src/geo/globe.js";
import { getGlobeTileAncestor } from "#src/geo/globe_tiles.js";
import {
  type DisplayDimensionRenderInfo,
  validateDisplayDimensionRenderInfoProperty,
} from "#src/navigation_state.js";
import type {
  RenderedViewBackend,
  RenderLayerBackendAttachment,
} from "#src/render_layer_backend.js";
import { RenderLayerBackend } from "#src/render_layer_backend.js";
import type { SharedWatchableValue } from "#src/shared_watchable_value.js";
import {
  BASE_PRIORITY,
  deserializeTransformedSources,
  SCALE_PRIORITY_MULTIPLIER,
} from "#src/sliceview/backend.js";
import type { TransformedSource } from "#src/sliceview/base.js";
import {
  getGlobeSourceLevels,
  updateGlobePositionInChunks,
  getGlobeTileView,
  GLOBE_VOLUME_RENDER_LAYER_RPC_ID,
  GLOBE_VOLUME_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  selectGlobeSourceTiles,
  setGlobeTilePosition,
} from "#src/sliceview/globe.js";
import type { VolumeChunkSource } from "#src/sliceview/volume/backend.js";
import {
  getBasePriority,
  getPriorityTier,
} from "#src/visibility_priority/backend.js";
import type { RPC } from "#src/worker_rpc.js";
import { registerRPC, registerSharedObject } from "#src/worker_rpc.js";

interface GlobeVolumeRenderLayerAttachmentState {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
  transformedSources: TransformedSource<
    GlobeVolumeRenderLayerBackend,
    VolumeChunkSource
  >[][];
}

@registerSharedObject(GLOBE_VOLUME_RENDER_LAYER_RPC_ID)
class GlobeVolumeRenderLayerBackend extends withChunkManager(
  RenderLayerBackend,
) {
  localPosition: SharedWatchableValue<Float32Array>;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
    this.localPosition = rpc.get(options.localPosition);
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    this.registerDisposer(
      this.localPosition.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.renderScaleTarget.changed.add(scheduleUpdateChunkPriorities),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() =>
        this.recomputeChunkPriorities(),
      ),
    );
  }

  attach(
    attachment: RenderLayerBackendAttachment<
      RenderedViewBackend,
      GlobeVolumeRenderLayerAttachmentState
    >,
  ) {
    const scheduleUpdateChunkPriorities = () =>
      this.chunkManager.scheduleUpdateChunkPriorities();
    const { view } = attachment;
    attachment.registerDisposer(scheduleUpdateChunkPriorities);
    attachment.registerDisposer(
      view.projectionParameters.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.registerDisposer(
      view.visibility.changed.add(scheduleUpdateChunkPriorities),
    );
    attachment.state = {
      displayDimensionRenderInfo:
        view.projectionParameters.value.displayDimensionRenderInfo,
      transformedSources: [],
    };
  }

  private recomputeChunkPriorities() {
    for (const attachment of this.attachments.values()) {
      const { view } = attachment;
      const visibility = view.visibility.value;
      if (visibility === Number.NEGATIVE_INFINITY) continue;
      const state = attachment.state as GlobeVolumeRenderLayerAttachmentState;
      const { transformedSources } = state;
      const projectionParameters = view.projectionParameters.value;
      if (
        transformedSources.length === 0 ||
        !validateDisplayDimensionRenderInfoProperty(
          state,
          projectionParameters.displayDimensionRenderInfo,
        )
      ) {
        continue;
      }
      const tileView = getGlobeTileView(projectionParameters);
      if (tileView === undefined) continue;
      const sourceLevels = getGlobeSourceLevels(transformedSources[0]);
      if (sourceLevels === undefined) continue;
      const { sources, levels } = sourceLevels;
      const priorityTier = getPriorityTier(visibility);
      const basePriority = getBasePriority(visibility) + BASE_PRIORITY;
      const { chunkManager } = this;
      chunkManager.registerLayer(this);
      const tiles = selectGlobeSourceTiles(
        sourceLevels,
        tileView,
        this.renderScaleTarget.value,
      );
      const { globalPosition } = projectionParameters;
      const localPosition = this.localPosition.value;
      const valid = sources.map((tsource) =>
        updateGlobePositionInChunks(tsource, globalPosition, localPosition),
      );
      const altitude = Math.max(
        1,
        Math.hypot(tileView.eye[0], tileView.eye[1], tileView.eye[2]) -
          WGS84_SEMI_MINOR_AXIS,
      );
      const requested = new Set<string>();
      const request = (
        level: number,
        x: number,
        y: number,
        priority: number,
        countAsVisible: boolean,
      ) => {
        if (!valid[level]) return;
        const key = `${level},${x},${y}`;
        if (requested.has(key)) return;
        requested.add(key);
        const tsource = sources[level];
        setGlobeTilePosition(tsource, x, y);
        const chunk = tsource.source.getChunk(tsource.curPositionInChunks);
        chunkManager.requestChunk(chunk, priorityTier, priority);
        if (countAsVisible) {
          ++this.numVisibleChunksNeeded;
          if (chunk.state === ChunkState.GPU_MEMORY) {
            ++this.numVisibleChunksAvailable;
          }
        }
      };
      const coarsest = levels.length - 1;
      for (const tile of tiles) {
        // Nearer tiles first, within the same level.
        const distancePriority = -Math.min(1e6, tile.distance / altitude);
        request(
          tile.level,
          tile.x,
          tile.y,
          basePriority + distancePriority,
          true,
        );
        // Ancestors serve as fallbacks while the tile is loading, and have higher priority.
        for (let a = tile.level + 1; a <= coarsest; ++a) {
          const [ax, ay] = getGlobeTileAncestor(
            levels,
            tile.level,
            tile.x,
            tile.y,
            a,
          );
          request(
            a,
            ax,
            ay,
            basePriority +
              SCALE_PRIORITY_MULTIPLIER * (a - tile.level) +
              distancePriority,
            false,
          );
        }
      }
    }
  }
}
GlobeVolumeRenderLayerBackend;

registerRPC(GLOBE_VOLUME_RENDER_LAYER_UPDATE_SOURCES_RPC_ID, function (x) {
  const view = this.get(x.view) as RenderedViewBackend;
  const layer = this.get(x.layer) as GlobeVolumeRenderLayerBackend;
  const attachment = layer.attachments.get(
    view,
  )! as RenderLayerBackendAttachment<
    RenderedViewBackend,
    GlobeVolumeRenderLayerAttachmentState
  >;
  attachment.state!.transformedSources = deserializeTransformedSources<
    VolumeChunkSource,
    GlobeVolumeRenderLayerBackend
  >(this, x.sources, layer);
  attachment.state!.displayDimensionRenderInfo = x.displayDimensionRenderInfo;
  layer.chunkManager.scheduleUpdateChunkPriorities();
});
