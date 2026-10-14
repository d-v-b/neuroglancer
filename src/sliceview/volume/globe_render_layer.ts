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
 * @file Display of georeferenced volume sources (e.g. map tiles) on the 3-d globe of the
 * perspective panel (see `src/sliceview/globe.ts`).
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import { getGlobeTileAncestor } from "#src/geo/globe_tiles.js";
import { chooseTerrainZoom } from "#src/geo/terrain.js";
import type { VisibleLayerInfo } from "#src/layer/index.js";
import type { PerspectivePanel } from "#src/perspective_view/panel.js";
import type { PerspectiveViewRenderContext } from "#src/perspective_view/render_layer.js";
import { PerspectiveViewRenderLayer } from "#src/perspective_view/render_layer.js";
import { SharedWatchableValue } from "#src/shared_watchable_value.js";
import type { FrontendTransformedSource } from "#src/sliceview/frontend.js";
import {
  getVolumetricTransformedSources,
  serializeAllTransformedSources,
} from "#src/sliceview/frontend.js";
import type { GlobeTileMesh } from "#src/sliceview/globe.js";
import {
  computeGlobeTileMesh,
  getGlobeSourceLevels,
  updateGlobePositionInChunks,
  getGlobeTileView,
  GLOBE_VOLUME_RENDER_LAYER_RPC_ID,
  GLOBE_VOLUME_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
  selectGlobeSourceTiles,
  setGlobeTilePosition,
} from "#src/sliceview/globe.js";
import type { VolumeChunk } from "#src/sliceview/volume/frontend.js";
import type {
  GlobeTileDrawInfo,
  GlobeTileGpuMesh,
  SliceViewVolumeRenderLayer,
} from "#src/sliceview/volume/renderlayer.js";
import type { NestedStateManager } from "#src/trackable_value.js";
import { registerNested } from "#src/trackable_value.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";

/**
 * Maximum number of cached tile meshes per source.
 */
const MAX_CACHED_TILE_MESHES = 4096;

/**
 * Stencil bit used to draw each pixel from the finest available tile only.
 */
const GLOBE_TILE_STENCIL_BIT = 2;

/**
 * Time budget per frame for computing tile meshes with terrain, beyond which meshes with outdated
 * terrain continue to be used, and the remaining meshes are computed in later frames.
 */
const TERRAIN_MESH_BUDGET_MS = 8;

class GlobeTileGpuMeshBuffers implements GlobeTileGpuMesh {
  origin: Float64Array;
  /**
   * Identifies the terrain settings with which the mesh was computed, or `""` without terrain.
   */
  terrainKey = "";
  /**
   * Indicates that the terrain at the desired resolution was not yet available, and the value of
   * `GlobeTerrainContext.generation` when the mesh was computed.
   */
  terrainIncomplete = false;
  terrainGeneration = 0;
  positionHigh: GLBuffer;
  positionLow: GLBuffer;
  chunkPosition: GLBuffer;
  indices: GLBuffer;
  numIndices: number;

  constructor(gl: GL, mesh: GlobeTileMesh) {
    this.origin = mesh.origin;
    this.positionHigh = GLBuffer.fromData(gl, mesh.positionHigh);
    this.positionLow = GLBuffer.fromData(gl, mesh.positionLow);
    this.chunkPosition = GLBuffer.fromData(gl, mesh.chunkPosition);
    this.indices = GLBuffer.fromData(
      gl,
      mesh.indices,
      WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
    );
    this.numIndices = mesh.indices.length;
  }

  dispose() {
    this.positionHigh.dispose();
    this.positionLow.dispose();
    this.chunkPosition.dispose();
    this.indices.dispose();
  }
}

/**
 * Cache of the tile meshes of a transformed source, in least-recently-used order.
 */
class GlobeTileMeshCache {
  meshes = new Map<string, GlobeTileGpuMeshBuffers>();

  /**
   * Returns the cached mesh, recomputing it if `isCurrent` returns `false` and `canCompute` returns
   * `true`.  Returns `undefined` if there is no cached mesh and it cannot be computed.
   */
  get(
    key: string,
    isCurrent: (mesh: GlobeTileGpuMeshBuffers) => boolean,
    canCompute: () => boolean,
    compute: () => GlobeTileGpuMeshBuffers,
  ) {
    const { meshes } = this;
    let mesh = meshes.get(key);
    if (mesh !== undefined) {
      meshes.delete(key);
      if (!isCurrent(mesh) && canCompute()) {
        mesh.dispose();
        mesh = compute();
      }
    } else {
      if (!canCompute()) return undefined;
      mesh = compute();
      if (meshes.size >= MAX_CACHED_TILE_MESHES) {
        const oldestKey = meshes.keys().next().value!;
        meshes.get(oldestKey)!.dispose();
        meshes.delete(oldestKey);
      }
    }
    meshes.set(key, mesh);
    return mesh;
  }

  dispose() {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
  }
}

interface GlobeVolumeAttachmentState {
  sources: NestedStateManager<FrontendTransformedSource[][]>;
  meshCaches: Map<FrontendTransformedSource, GlobeTileMeshCache>;
}

/**
 * Draws a georeferenced volume source shown by a `SliceViewVolumeRenderLayer` (e.g. map tiles in
 * an image layer) on the globe of the perspective panel, using the shader of that render layer.
 */
export class GlobeVolumeRenderLayer extends PerspectiveViewRenderLayer<GlobeVolumeAttachmentState> {
  backend: ChunkRenderLayerFrontend;

  get isGlobeLayer() {
    return true;
  }

  get gl() {
    return this.base.gl;
  }

  constructor(public base: SliceViewVolumeRenderLayer) {
    super();
    this.registerDisposer(base.addRef());
    this.registerDisposer(base.redrawNeeded.add(this.redrawNeeded.dispatch));
    const { chunkManager } = base.multiscaleSource;
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = GLOBE_VOLUME_RENDER_LAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, base.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, base.renderScaleTarget),
      ).rpcId,
    });
    this.backend = sharedObject;
  }

  attach(
    attachment: VisibleLayerInfo<PerspectivePanel, GlobeVolumeAttachmentState>,
  ) {
    super.attach(attachment);
    const meshCaches = new Map<FrontendTransformedSource, GlobeTileMeshCache>();
    const clearMeshCaches = () => {
      for (const cache of meshCaches.values()) cache.dispose();
      meshCaches.clear();
    };
    attachment.registerDisposer(clearMeshCaches);
    const { base } = this;
    attachment.state = {
      meshCaches,
      sources: attachment.registerDisposer(
        registerNested(
          (context, transform, displayDimensionRenderInfo) => {
            clearMeshCaches();
            const transformedSources = getVolumetricTransformedSources(
              displayDimensionRenderInfo,
              transform,
              (options) => base.multiscaleSource.getSources(options),
              attachment.messages,
              this,
            );
            for (const scales of transformedSources) {
              for (const tsource of scales) {
                context.registerDisposer(tsource.source);
              }
            }
            attachment.view.flushBackendProjectionParameters();
            this.backend.rpc!.invoke(
              GLOBE_VOLUME_RENDER_LAYER_UPDATE_SOURCES_RPC_ID,
              {
                layer: this.backend.rpcId,
                view: attachment.view.rpcId,
                sources: serializeAllTransformedSources(transformedSources),
                displayDimensionRenderInfo,
              },
            );
            this.redrawNeeded.dispatch();
            return transformedSources;
          },
          base.transform,
          attachment.view.displayDimensionRenderInfo,
        ),
      ),
    };
  }

  draw(
    renderContext: PerspectiveViewRenderContext,
    attachment: VisibleLayerInfo<PerspectivePanel, GlobeVolumeAttachmentState>,
  ) {
    if (!renderContext.emitColor) return;
    const { projectionParameters } = renderContext;
    const view = getGlobeTileView(projectionParameters);
    if (view === undefined) return;
    const state = attachment.state!;
    const allSources = state.sources.value;
    if (allSources.length === 0) return;
    const sourceLevels = getGlobeSourceLevels(allSources[0]);
    if (sourceLevels === undefined) return;
    const { sources, levels, footprintCache } = sourceLevels;
    const { base, gl } = this;
    const localPosition = base.localPosition.value;
    const valid = sources.map(
      (tsource) =>
        tsource.geo!.subspaceIndices !== undefined &&
        updateGlobePositionInChunks(
          tsource,
          projectionParameters.globalPosition,
          localPosition,
        ),
    );
    const tiles = selectGlobeSourceTiles(
      sourceLevels,
      view,
      base.renderScaleTarget.value,
    );

    const { globeTerrain } = renderContext;
    const terrainKey =
      globeTerrain === undefined ? "" : `${globeTerrain.exaggeration}`;
    const meshDeadline = performance.now() + TERRAIN_MESH_BUDGET_MS;
    let meshesDeferred = false;
    const getMesh = (level: number, x: number, y: number) => {
      const tsource = sources[level];
      let meshCache = state.meshCaches.get(tsource);
      if (meshCache === undefined) {
        meshCache = new GlobeTileMeshCache();
        state.meshCaches.set(tsource, meshCache);
      }
      return meshCache.get(
        `${x},${y}`,
        (mesh) =>
          mesh.terrainKey === terrainKey &&
          !(
            mesh.terrainIncomplete &&
            mesh.terrainGeneration !== globeTerrain?.generation
          ),
        () => {
          // Meshes without terrain are cheap to compute.
          if (globeTerrain === undefined || performance.now() < meshDeadline) {
            return true;
          }
          meshesDeferred = true;
          return false;
        },
        () => {
          const status = { exact: true };
          let getHeight:
            | ((lon: number, lat: number, spacing: number) => number)
            | undefined;
          if (globeTerrain !== undefined) {
            const { source, exaggeration } = globeTerrain;
            getHeight = (lon, lat, spacing) => {
              const elevation = source.sample(
                lon,
                lat,
                chooseTerrainZoom(spacing, lat),
                status,
              );
              // The ocean surface remains at sea level.
              return Math.max(0, elevation ?? 0) * exaggeration;
            };
          }
          const mesh = new GlobeTileGpuMeshBuffers(
            gl,
            computeGlobeTileMesh(
              levels[level],
              x,
              y,
              2 * footprintCache.get(levels, level, x, y).coneAngle,
              getHeight,
            ),
          );
          mesh.terrainKey = terrainKey;
          mesh.terrainIncomplete = !status.exact;
          mesh.terrainGeneration = globeTerrain?.generation ?? 0;
          return mesh;
        },
      );
    };

    // For each selected tile, draw the tile if it is loaded, and otherwise its nearest loaded
    // ancestor as a fallback.
    const draws = new Map<
      string,
      GlobeTileDrawInfo & { level: number; selected: boolean }
    >();
    const getLoadedChunk = (level: number, x: number, y: number) => {
      const tsource = sources[level];
      setGlobeTilePosition(tsource, x, y);
      const chunk = tsource.source.chunks.get(
        tsource.curPositionInChunks.join(),
      ) as VolumeChunk | undefined;
      if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
        return undefined;
      }
      // Chunks without data (e.g. missing map tiles) are not drawn.
      if ((chunk as { data?: unknown }).data === null) return undefined;
      return chunk;
    };
    for (const tile of tiles) {
      for (let level = tile.level; level < levels.length; ++level) {
        if (!valid[level]) continue;
        const selected = level === tile.level;
        const [x, y] = selected
          ? [tile.x, tile.y]
          : getGlobeTileAncestor(levels, tile.level, tile.x, tile.y, level);
        const key = `${level},${x},${y}`;
        const existing = draws.get(key);
        if (existing !== undefined) {
          existing.selected ||= selected;
          break;
        }
        const chunk = getLoadedChunk(level, x, y);
        if (chunk === undefined) continue;
        const mesh = getMesh(level, x, y);
        if (mesh === undefined) continue;
        draws.set(key, {
          tsource: sources[level],
          chunk,
          mesh,
          level,
          selected,
        });
        break;
      }
    }
    if (meshesDeferred) {
      // Compute the remaining meshes in the next frame.
      requestAnimationFrame(() => this.redrawNeeded.dispatch());
    }
    if (draws.size === 0) return;
    // Finer tiles take precedence.
    const sortedDraws = Array.from(draws.values()).sort(
      (a, b) => a.level - b.level,
    );

    base.setGLBlendMode(gl, 1);
    // Tiles facing away from the camera (e.g. on the far side of the Earth) are hidden.
    gl.enable(WebGL2RenderingContext.CULL_FACE);
    gl.cullFace(WebGL2RenderingContext.BACK);
    gl.frontFace(WebGL2RenderingContext.CCW);
    gl.enable(WebGL2RenderingContext.DEPTH_TEST);
    gl.depthFunc(WebGL2RenderingContext.LEQUAL);
    gl.enable(WebGL2RenderingContext.POLYGON_OFFSET_FILL);
    const { viewProjectionMat } = projectionParameters;
    if ((renderContext.globeLayerIndex ?? 0) === 0) {
      // The bottom layer defines the depth of the surface (which, with terrain, may hide itself).
      // Fallback tiles are pushed back, such that they are hidden by loaded finer tiles.
      gl.depthMask(true);
      gl.polygonOffset(0, 0);
      base.drawGlobeTiles(
        viewProjectionMat,
        view.target,
        sortedDraws.filter((d) => d.selected),
      );
      gl.polygonOffset(1, 16);
      base.drawGlobeTiles(
        viewProjectionMat,
        view.target,
        sortedDraws.filter((d) => !d.selected),
      );
    } else {
      // Other layers are drawn over the surface defined by the bottom layer, pulled forward to
      // account for differences in their meshes, with each pixel drawn from the finest tile.
      gl.depthMask(false);
      gl.polygonOffset(-1, -16);
      gl.enable(WebGL2RenderingContext.STENCIL_TEST);
      gl.stencilMask(GLOBE_TILE_STENCIL_BIT);
      gl.clear(WebGL2RenderingContext.STENCIL_BUFFER_BIT);
      gl.stencilFunc(
        WebGL2RenderingContext.NOTEQUAL,
        GLOBE_TILE_STENCIL_BIT,
        GLOBE_TILE_STENCIL_BIT,
      );
      gl.stencilOp(
        WebGL2RenderingContext.KEEP,
        WebGL2RenderingContext.KEEP,
        WebGL2RenderingContext.REPLACE,
      );
      base.drawGlobeTiles(viewProjectionMat, view.target, sortedDraws);
      gl.stencilMask(0xffffffff);
      gl.stencilFunc(WebGL2RenderingContext.ALWAYS, 1, 1);
    }
    gl.polygonOffset(0, 0);
    gl.disable(WebGL2RenderingContext.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.depthFunc(WebGL2RenderingContext.LESS);
    gl.disable(WebGL2RenderingContext.CULL_FACE);
    gl.disable(WebGL2RenderingContext.BLEND);
  }
}
