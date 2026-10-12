/**
 * @license
 * Copyright 2016 Google Inc.
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

import { ChunkState } from "#src/chunk_manager/base.js";
import type { CoordinateSpace } from "#src/coordinate_transform.js";
import { emptyInvalidCoordinateSpace } from "#src/coordinate_transform.js";
import type { ProjectionParameters } from "#src/projection_parameters.js";
import { getChunkPositionFromCombinedGlobalLocalPositions } from "#src/render_coordinate_transform.js";
import { getNormalizedChunkLayout } from "#src/sliceview/base.js";
import {
  computeVertexPositionDebug,
  defineBoundingBoxCrossSectionShader,
  setBoundingBoxCrossSectionShaderViewportPlane,
} from "#src/sliceview/bounding_box_shader_helper.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type {
  FrontendTransformedSource,
  SliceView,
} from "#src/sliceview/frontend.js";
import type { GeoChunkMesh } from "#src/sliceview/geo.js";
import {
  beginGeoMeshFrame,
  GEO_MESH_BUILD_BUDGET_MS,
  correctGeoChunkPosition,
  getGeoChunkMesh,
  getGeoChunkMeshCopies,
  GeoRenderingMode,
  getGeoRenderingMode,
  getGeoViewParameters,
} from "#src/sliceview/geo.js";
import type {
  SliceViewRenderContext,
  SliceViewRenderLayerOptions,
} from "#src/sliceview/renderlayer.js";
import { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import type {
  ChunkFormat,
  MultiscaleVolumeChunkSource,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { defineChunkDataShaderAccess } from "#src/sliceview/volume/frontend.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import {
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/trackable_value.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { getObjectId } from "#src/util/object_id.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type {
  ParameterizedContextDependentShaderGetter,
  ParameterizedShaderGetterResult,
  WatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import {
  makeWatchableShaderError,
  parameterizedContextDependentShaderGetter,
} from "#src/webgl/dynamic_shader.js";
import type { HistogramChannelSpecification } from "#src/webgl/empirical_cdf.js";
import {
  defineInvlerpShaderFunction,
  enableLerpShaderFunction,
} from "#src/webgl/lerp.js";
import {
  defineLineShader,
  drawLines,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#src/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const DEBUG_VERTICES = false;

/**
 * Extra amount by which the chunk position computed in the vertex shader is shifted in the
 * direction of the component-wise absolute value of the plane normal.  In Neuroglancer, a
 * cross-section plane exactly on the boundary between two voxels is a common occurrence and is
 * intended to result in the display of the "next" (i.e. higher coordinate) plane rather than the
 * "previous" (lower coordinate) plane.  However, due to various sources of floating point
 * inaccuracy (in particular, shader code which has relaxed rules), values exactly on the boundary
 * between voxels may be slightly shifted in either direction.  To ensure that this doesn't result
 * in the display of the wrong data (i.e. the previous rather than next plane), we always shift
 * toward the "next" plane by this small amount.
 */
const CHUNK_POSITION_EPSILON = 1e-3;

const tempMat4 = mat4.create();

/**
 * Attribute locations used for rendering georeferenced sources.  Location 0 is reserved for the
 * dummy vertex id attribute (see `vertex_id.ts`).
 */
const GEO_POSITION_ATTRIBUTE_LOCATION = 1;
const GEO_POSITION_LOW_ATTRIBUTE_LOCATION = 2;
const GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION = 3;

/**
 * Defines the vertex shader for rendering georeferenced sources, which are drawn as triangle meshes
 * computed on the CPU (see `src/sliceview/geo.ts`) rather than as box-plane intersections.
 */
function defineGeoVolumeShader(builder: ShaderBuilder, wireFrame: boolean) {
  // Display position of the vertex relative to the origin of the chunk mesh, split into high and
  // low parts (each representable in single precision) to preserve precision for meshes far from
  // the center of the view.
  builder.addAttribute(
    "highp vec3",
    "aGeoPosition",
    GEO_POSITION_ATTRIBUTE_LOCATION,
  );
  builder.addAttribute(
    "highp vec3",
    "aGeoPositionLow",
    GEO_POSITION_LOW_ATTRIBUTE_LOCATION,
  );
  // Position within the chunk along the two georeferenced chunk dimensions.
  builder.addAttribute(
    "highp vec2",
    "aGeoChunkPosition",
    GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION,
  );
  builder.addUniform("highp mat4", "uProjectionMatrix");
  // Display offset of the mesh origin relative to the center of the view (including the offset of
  // the current world copy), split into high and low parts.
  builder.addUniform("highp vec3", "uGeoOffset");
  builder.addUniform("highp vec3", "uGeoOffsetLow");
  builder.addUniform("highp vec3", "uGeoChunkAxisX");
  builder.addUniform("highp vec3", "uGeoChunkAxisY");
  builder.addUniform("highp vec3", "uGeoChunkBase");
  builder.addUniform("highp vec3", "uChunkDataSize");
  if (wireFrame) {
    builder.setVertexMain(`
gl_Position = uProjectionMatrix * vec4(
    (aGeoPosition + uGeoOffset) + (aGeoPositionLow + uGeoOffsetLow), 1.0);
gl_Position.z = 0.0;
`);
    builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, 0.5));
`);
    return;
  }
  builder.addVarying("highp vec3", "vChunkPosition");
  builder.setVertexMain(`
gl_Position = uProjectionMatrix * vec4(
    (aGeoPosition + uGeoOffset) + (aGeoPositionLow + uGeoOffsetLow), 1.0);
gl_Position.z = 0.0;
vChunkPosition = uGeoChunkBase + aGeoChunkPosition.x * uGeoChunkAxisX +
    aGeoChunkPosition.y * uGeoChunkAxisY;
`);
}

/**
 * GPU buffers for a georeferenced chunk mesh.  Vertex positions are stored in display
 * coordinates relative to the mesh origin, such that they are small enough for single precision.
 */
class GeoChunkGpuMesh {
  position: GLBuffer;
  positionLow: GLBuffer;
  chunkPosition: GLBuffer;
  triangles: GLBuffer;
  private lines: GLBuffer | undefined;
  numTriangleIndices: number;
  numLineIndices: number;
  originX: number;
  originY: number;

  constructor(
    private gl: GL,
    private mesh: GeoChunkMesh,
    transform: mat4,
    si: number,
    sj: number,
  ) {
    const { numVertices, warped, warpedLower, indices } = mesh;
    const originX = (this.originX = warpedLower[0]);
    const originY = (this.originY = warpedLower[1]);
    const positions = new Float32Array(numVertices * 3);
    const positionsLow = new Float32Array(numVertices * 3);
    for (let v = 0; v < numVertices; ++v) {
      const wx = warped[2 * v] - originX;
      const wy = warped[2 * v + 1] - originY;
      for (let i = 0; i < 3; ++i) {
        const d = transform[si * 4 + i] * wx + transform[sj * 4 + i] * wy;
        const high = Math.fround(d);
        positions[3 * v + i] = high;
        positionsLow[3 * v + i] = d - high;
      }
    }
    this.position = GLBuffer.fromData(gl, positions);
    this.positionLow = GLBuffer.fromData(gl, positionsLow);
    this.chunkPosition = GLBuffer.fromData(gl, mesh.positionWithinChunk);
    this.triangles = GLBuffer.fromData(
      gl,
      indices,
      WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
    );
    this.numTriangleIndices = indices.length;
    this.numLineIndices = indices.length * 2;
  }

  getLines() {
    let { lines } = this;
    if (lines === undefined) {
      const { indices } = this.mesh;
      const lineIndices = new Uint32Array(indices.length * 2);
      for (let t = 0, o = 0; t < indices.length; t += 3) {
        const a = indices[t];
        const b = indices[t + 1];
        const c = indices[t + 2];
        lineIndices[o++] = a;
        lineIndices[o++] = b;
        lineIndices[o++] = b;
        lineIndices[o++] = c;
        lineIndices[o++] = c;
        lineIndices[o++] = a;
      }
      lines = this.lines = GLBuffer.fromData(
        this.gl,
        lineIndices,
        WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
      );
    }
    return lines;
  }

  dispose() {
    this.position.dispose();
    this.positionLow.dispose();
    this.chunkPosition.dispose();
    this.triangles.dispose();
    this.lines?.dispose();
  }
}

function getGeoChunkGpuMesh(
  gl: GL,
  mesh: GeoChunkMesh,
  transform: mat4,
  si: number,
  sj: number,
): GeoChunkGpuMesh {
  let gpuMesh = mesh.gpuMesh as GeoChunkGpuMesh | undefined;
  if (gpuMesh === undefined) {
    gpuMesh = new GeoChunkGpuMesh(gl, mesh, transform, si, sj);
    mesh.gpuMesh = gpuMesh;
  }
  return gpuMesh;
}

function defineVolumeShader(
  builder: ShaderBuilder,
  wireFrame: boolean,
  geo: boolean,
) {
  if (geo) {
    defineGeoVolumeShader(builder, wireFrame);
    return;
  }
  defineVertexId(builder);
  defineBoundingBoxCrossSectionShader(builder);

  // Specifies translation of the current chunk.
  builder.addUniform("highp vec3", "uTranslation");

  // Matrix by which computed vertices will be transformed.
  builder.addUniform("highp mat4", "uProjectionMatrix");

  // Chunk size in voxels.
  builder.addUniform("highp vec3", "uChunkDataSize");

  builder.addUniform("highp vec3", "uLowerClipBound");
  builder.addUniform("highp vec3", "uUpperClipBound");

  if (wireFrame) {
    defineLineShader(builder);
    builder.setVertexMain(`
int vertexIndex1 = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
    builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, getLineAlpha()));
`);
    return;
  }

  // Position within chunk of vertex, in floating point range [0, chunkDataSize].
  builder.addVarying("highp vec3", "vChunkPosition");

  // Set gl_Position.z = 0 since we use the depth buffer as a stencil buffer to avoid overwriting
  // higher-resolution data with lower-resolution data.  The depth buffer is used rather than the
  // stencil buffer because for computing data distributions we need to read from it, and WebGL2
  // does not support reading from the stencil component of a depth-stencil texture.
  builder.setVertexMain(`
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, gl_VertexID);
gl_Position = uProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
vChunkPosition = (position - uTranslation) +
    ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);
}

function computeVerticesDebug(
  uChunkDataSize: vec3,
  uLowerClipBound: vec3,
  uUpperClipBound: vec3,
  uPlaneDistance: number,
  uPlaneNormal: vec3,
  uTranslation: vec3,
  uProjectionMatrix: mat4,
) {
  const gl_Position = vec3.create();
  const vChunkPosition = vec3.create();
  const planeNormalAbs = vec3.fromValues(
    Math.abs(uPlaneNormal[0]),
    Math.abs(uPlaneNormal[1]),
    Math.abs(uPlaneNormal[2]),
  );
  const prevVertex = vec3.create();
  for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
    const position = computeVertexPositionDebug(
      uChunkDataSize,
      uLowerClipBound,
      uUpperClipBound,
      uPlaneDistance,
      uPlaneNormal,
      uTranslation,
      vertexIndex,
    );
    if (position === undefined) {
      console.log("no intersection found");
      return;
    }
    vec3.transformMat4(gl_Position, position, uProjectionMatrix);
    const skipped = vertexIndex !== 0 && vec3.equals(gl_Position, prevVertex);
    vec3.copy(prevVertex, gl_Position);
    vec3.sub(vChunkPosition, position, uTranslation);
    vec3.scaleAndAdd(
      vChunkPosition,
      vChunkPosition,
      planeNormalAbs,
      CHUNK_POSITION_EPSILON,
    );
    console.log(
      `${skipped ? "SKIPPED" : "OUTPUT"} vertex ${vertexIndex}, ` +
        `at ${gl_Position}, vChunkPosition = ${vChunkPosition}, ` +
        `uTranslation=${uTranslation.join()}, position=${position.join()}`,
    );
  }
}

function initializeShader(
  shader: ShaderProgram,
  projectionParameters: ProjectionParameters,
  wireFrame: boolean,
) {
  if (wireFrame) {
    initializeLineShader(
      shader,
      projectionParameters,
      /*featherWidthInPixels=*/ 1,
    );
  }
}

function beginSource(
  gl: GL,
  shader: ShaderProgram,
  sliceView: SliceView,
  dataToDeviceMatrix: mat4,
  tsource: FrontendTransformedSource,
  chunkLayout: ChunkLayout,
) {
  const projectionParameters = sliceView.projectionParameters.value;
  const { centerDataPosition } = projectionParameters;

  setBoundingBoxCrossSectionShaderViewportPlane(
    shader,
    projectionParameters.viewportNormalInGlobalCoordinates,
    centerDataPosition,
    chunkLayout.transform,
    chunkLayout.invTransform,
  );

  // Compute projection matrix that transforms chunk layout coordinates to device coordinates.
  gl.uniformMatrix4fv(
    shader.uniform("uProjectionMatrix"),
    false,
    mat4.multiply(tempMat4, dataToDeviceMatrix, chunkLayout.transform),
  );

  gl.uniform3fv(
    shader.uniform("uLowerClipBound"),
    tsource.lowerClipDisplayBound,
  );
  gl.uniform3fv(
    shader.uniform("uUpperClipBound"),
    tsource.upperClipDisplayBound,
  );
  if (DEBUG_VERTICES) {
    (<any>window).debug_sliceView_uLowerClipBound =
      tsource.lowerClipDisplayBound;
    (<any>window).debug_sliceView_uUpperClipBound =
      tsource.upperClipDisplayBound;
    (<any>window).debug_sliceView = sliceView;
    (<any>window).debug_sliceView_dataToDevice = mat4.clone(tempMat4);
    (<any>window).debug_sliceView_chunkLayout = chunkLayout;
  }
}

function setupChunkDataSize(
  gl: GL,
  shader: ShaderProgram,
  chunkDataSize: vec3,
) {
  gl.uniform3fv(shader.uniform("uChunkDataSize"), chunkDataSize);

  if (DEBUG_VERTICES) {
    (<any>window).debug_sliceView_chunkDataSize = chunkDataSize;
  }
}

function drawChunk(
  gl: GL,
  shader: ShaderProgram,
  chunkPosition: vec3,
  wireFrame: boolean,
) {
  gl.uniform3fv(shader.uniform("uTranslation"), chunkPosition);
  if (wireFrame) {
    drawLines(shader.gl, 6, 1);
  } else {
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);
  }

  if (DEBUG_VERTICES) {
    const sliceView: SliceView = (<any>window).debug_sliceView;
    const projectionParameters = sliceView.projectionParameters.value;
    const chunkDataSize: vec3 = (<any>window).debug_sliceView_chunkDataSize;
    const lowerClipBound: vec3 = (<any>window).debug_sliceView_uLowerClipBound;
    const upperClipBound: vec3 = (<any>window).debug_sliceView_uUpperClipBound;
    const dataToDeviceMatrix: mat4 = (<any>window).debug_sliceView_dataToDevice;
    const chunkLayout: ChunkLayout = (<any>window).debug_sliceView_chunkLayout;
    console.log(
      `Drawing chunk: ${chunkPosition.join()} of data size ` +
        `${chunkDataSize.join()}, projection`,
      dataToDeviceMatrix,
    );
    const localPlaneNormal = chunkLayout.globalToLocalNormal(
      vec3.create(),
      projectionParameters.viewportNormalInGlobalCoordinates,
    );
    const planeDistanceToOrigin = vec3.dot(
      vec3.transformMat4(
        vec3.create(),
        projectionParameters.centerDataPosition,
        chunkLayout.invTransform,
      ),
      localPlaneNormal,
    );
    computeVerticesDebug(
      chunkDataSize,
      lowerClipBound,
      upperClipBound,
      planeDistanceToOrigin,
      localPlaneNormal,
      chunkPosition,
      dataToDeviceMatrix,
    );
  }
}

export interface RenderLayerBaseOptions extends SliceViewRenderLayerOptions {
  shaderError?: WatchableShaderError;
  channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace>;
}

export interface RenderLayerOptions<ShaderParameters>
  extends RenderLayerBaseOptions {
  fallbackShaderParameters?: WatchableValueInterface<ShaderParameters>;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  encodeShaderParameters?: (parameters: ShaderParameters) => any;
}

function medianOf3(a: number, b: number, c: number) {
  return a > b ? (c > a ? a : b > c ? b : c) : c > b ? b : a > c ? a : c;
}

interface ShaderContext {
  numChannelDimensions: number;
  dataHistogramChannelSpecifications: HistogramChannelSpecification[];
}

export abstract class SliceViewVolumeRenderLayer<
  ShaderParameters = any,
> extends SliceViewRenderLayer<VolumeChunkSource, VolumeSourceOptions> {
  declare multiscaleSource: MultiscaleVolumeChunkSource;
  protected shaderGetter: ParameterizedContextDependentShaderGetter<
    {
      chunkFormat: ChunkFormat | null;
      dataHistogramsEnabled: boolean;
      geo: boolean;
    },
    ShaderParameters,
    ShaderContext
  >;
  private tempChunkPosition: Float32Array;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  highestResolutionLoadedVoxelSize: Float32Array | undefined;
  private vertexIdHelper: VertexIdHelper;

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: RenderLayerOptions<ShaderParameters>,
  ) {
    const { shaderError = makeWatchableShaderError(), shaderParameters } =
      options;
    super(multiscaleSource.chunkManager, multiscaleSource, options);
    const { gl } = this;
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    this.shaderParameters = shaderParameters;
    const { channelCoordinateSpace } = options;
    this.channelCoordinateSpace =
      channelCoordinateSpace === undefined
        ? constantWatchableValue(emptyInvalidCoordinateSpace)
        : channelCoordinateSpace;
    this.registerDisposer(
      shaderParameters.changed.add(this.redrawNeeded.dispatch),
    );
    // The shader depends on the `ChunkFormat` (which is a property of the `VolumeChunkSource`), the
    // `ShaderParameters` (which are determined by the derived RenderLayer class), the number of
    // channel dimensions, and the data histogram channel specifications.
    const extraParameters = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (
          space: CoordinateSpace,
          dataHistogramChannelSpecifications: HistogramChannelSpecification[],
        ) => ({
          numChannelDimensions: space.rank,
          dataHistogramChannelSpecifications,
        }),
        [
          this.channelCoordinateSpace,
          this.dataHistogramSpecifications.channels,
        ],
      ),
    );
    this.shaderGetter = parameterizedContextDependentShaderGetter(this, gl, {
      memoizeKey: `volume/RenderLayer:${getObjectId(this.constructor)}`,
      fallbackParameters: options.fallbackShaderParameters,
      parameters: shaderParameters,
      encodeParameters: options.encodeShaderParameters,
      shaderError,
      extraParameters,
      defineShader: (
        builder: ShaderBuilder,
        context: {
          chunkFormat: ChunkFormat | null;
          dataHistogramsEnabled: boolean;
          geo: boolean;
        },
        parameters: ShaderParameters,
        extraParameters: ShaderContext,
      ) => {
        const { chunkFormat, dataHistogramsEnabled, geo } = context;
        const { dataHistogramChannelSpecifications, numChannelDimensions } =
          extraParameters;
        defineVolumeShader(builder, chunkFormat === null, geo);
        builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
        builder.addFragmentCode(`
void emit(vec4 color) {
  v4f_fragData0 = color;
}
`);
        if (chunkFormat === null) {
          return;
        }
        defineChunkDataShaderAccess(
          builder,
          chunkFormat,
          numChannelDimensions,
          "vChunkPosition",
        );
        const numHistograms = dataHistogramChannelSpecifications.length;
        if (dataHistogramsEnabled && numHistograms > 0) {
          let histogramCollectionCode = "";
          const { dataType } = chunkFormat;
          for (let i = 0; i < numHistograms; ++i) {
            const { channel } = dataHistogramChannelSpecifications[i];
            const outputName = `out_histogram${i}`;
            builder.addOutputBuffer("vec4", outputName, 1 + i);
            const getDataValueExpr = `getDataValue(${channel.join(",")})`;
            const invlerpName = `invlerpForHistogram${i}`;
            builder.addFragmentCode(
              defineInvlerpShaderFunction(
                builder,
                invlerpName,
                dataType,
                /*clamp=*/ false,
              ),
            );
            builder.addFragmentCode(`
float getHistogramValue${i}() {
  return invlerpForHistogram${i}(${getDataValueExpr});
}
`);
            histogramCollectionCode += `{
float x = getHistogramValue${i}();
if (x < 0.0) x = 0.0;
else if (x > 1.0) x = 1.0;
else x = (1.0 + x * 253.0) / 255.0;
${outputName} = vec4(x, x, x, 1.0);
}`;
          }
          builder.addFragmentCode(`void userMain();
void main() {
  ${histogramCollectionCode}
  userMain();
}
#define main userMain\n`);
        }
        this.defineShader(builder, parameters);
      },
      getContextKey: (context) =>
        `${context.chunkFormat?.shaderKey}/${context.dataHistogramsEnabled}/${context.geo}`,
    });
    this.tempChunkPosition = new Float32Array(multiscaleSource.rank);
    this.initializeCounterpart();
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  /**
   * Returns the georeferenced sources that are not shown (`GeoRenderingMode.HIDDEN`) in
   * `sliceView`, e.g. 2-d map tiles in a vertical section.
   */
  private getHiddenGeoSources(
    sliceView: SliceView | undefined,
  ): Set<unknown> | undefined {
    if (sliceView === undefined) return undefined;
    const layerInfo = sliceView.visibleLayers.get(this);
    if (layerInfo === undefined) return undefined;
    const projectionParameters = sliceView.projectionParameters.value;
    let hidden: Set<unknown> | undefined;
    for (const scales of layerInfo.allSources) {
      for (const tsource of scales) {
        if (tsource.geo === undefined) continue;
        const mode = getGeoRenderingMode(
          tsource,
          projectionParameters,
          getNormalizedChunkLayout(projectionParameters, tsource.chunkLayout),
        );
        if (mode === GeoRenderingMode.HIDDEN) {
          (hidden ??= new Set()).add(tsource.source);
        }
      }
    }
    return hidden;
  }

  /**
   * @param pickState If it specifies the slice view in which `globalPosition` was picked, sources
   *     that are not shown in that view are skipped.
   */
  getValueAt(
    globalPosition: Float32Array,
    pickState?: { pickedSliceView?: SliceView },
  ) {
    const { tempChunkPosition } = this;
    const hiddenSources = this.getHiddenGeoSources(pickState?.pickedSliceView);
    for (const { source, chunkTransform, geoWarp } of this.visibleSourcesList) {
      if (hiddenSources?.has(source)) continue;
      if (
        !getChunkPositionFromCombinedGlobalLocalPositions(
          tempChunkPosition,
          globalPosition,
          this.localPosition.value,
          chunkTransform.layerRank,
          chunkTransform.combinedGlobalLocalToChunkTransform,
        )
      ) {
        continue;
      }
      if (
        geoWarp !== undefined &&
        !correctGeoChunkPosition(
          geoWarp,
          tempChunkPosition,
          source.spec.lowerVoxelBound,
          source.spec.upperVoxelBound,
        )
      ) {
        continue;
      }
      const result = source.getValueAt(tempChunkPosition, chunkTransform);
      if (result != null) {
        return result;
      }
    }
    return null;
  }

  beginChunkFormat(
    sliceView: SliceView,
    chunkFormat: ChunkFormat | null,
    projectionParameters: ProjectionParameters,
    geo = false,
  ): ParameterizedShaderGetterResult<ShaderParameters, ShaderContext> {
    const { gl } = this;
    const dataHistogramsEnabled =
      this.dataHistogramSpecifications.visibility.visible;
    const shaderResult = this.shaderGetter({
      chunkFormat,
      dataHistogramsEnabled,
      geo,
    });
    const { shader, parameters, fallback } = shaderResult;
    if (shader !== null) {
      shader.bind();
      if (!geo) {
        initializeShader(shader, projectionParameters, chunkFormat === null);
      }
      if (chunkFormat !== null) {
        if (dataHistogramsEnabled) {
          const { dataHistogramChannelSpecifications } =
            shaderResult.extraParameters;
          const numHistograms = dataHistogramChannelSpecifications.length;
          const bounds = this.dataHistogramSpecifications.bounds.value;
          for (let i = 0; i < numHistograms; ++i) {
            enableLerpShaderFunction(
              shader,
              `invlerpForHistogram${i}`,
              chunkFormat.dataType,
              bounds[i],
            );
          }
        }
        this.initializeShader(sliceView, shader, parameters, fallback);
        // FIXME: may need to fix wire frame rendering
        chunkFormat.beginDrawing(gl, shader);
      }
    }
    return shaderResult;
  }

  abstract initializeShader(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
    fallback: boolean,
  ): void;

  abstract defineShader(
    builder: ShaderBuilder,
    parameters: ShaderParameters,
  ): void;

  endSlice(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    sliceView;
    shader;
    parameters;
  }

  /**
   * Draws the visible chunks of a georeferenced source as adaptive triangle meshes.
   *
   * @returns `[presentCount, notPresentCount]`.
   */
  private drawGeoSource(
    renderContext: SliceViewRenderContext,
    shader: ShaderProgram,
    transformedSource: FrontendTransformedSource,
    chunkLayout: ChunkLayout,
    chunkFormat: ChunkFormat | null,
  ): [number, number] {
    const { sliceView, projectionParameters, wireFrame } = renderContext;
    const geo = transformedSource.geo!;
    const view = getGeoViewParameters(geo, projectionParameters, chunkLayout);
    if (view === undefined) return [0, 0];
    const { gl } = this;
    const { si, sj, sk, thirdCoordinate } = view;
    const source = transformedSource.source as VolumeChunkSource;
    const { chunks } = source;
    const chunkRank = source.spec.rank;
    const {
      chunkDisplayDimensionIndices,
      fixedPositionWithinChunk,
      chunkTransform: { channelToChunkDimensionIndices },
    } = transformedSource;
    const chunkDimX = chunkDisplayDimensionIndices[si];
    const chunkDimY = chunkDisplayDimensionIndices[sj];
    const chunkDimK = chunkDisplayDimensionIndices[sk];
    // The static part of the chunk layout transform, used for the vertex positions stored in the
    // (cached) chunk mesh buffers.
    const staticTransform = transformedSource.chunkLayout.transform;
    const { transform } = chunkLayout;
    const { invViewMatrix, viewProjectionMat } = projectionParameters;
    const center = [invViewMatrix[12], invViewMatrix[13], invViewMatrix[14]];

    // Projection matrix for center-relative positions: viewProjection * translate(center).
    {
      const m = tempMat4;
      mat4.copy(m, viewProjectionMat);
      for (let i = 0; i < 4; ++i) {
        m[12 + i] =
          viewProjectionMat[i] * center[0] +
          viewProjectionMat[4 + i] * center[1] +
          viewProjectionMat[8 + i] * center[2] +
          viewProjectionMat[12 + i];
      }
      gl.uniformMatrix4fv(shader.uniform("uProjectionMatrix"), false, m);
    }

    // Display displacement of one world period.
    const worldPeriodDisplay = [0, 0, 0];
    const { worldPeriodSubspace } = view;
    if (worldPeriodSubspace !== undefined) {
      for (let i = 0; i < 3; ++i) {
        let sum = 0;
        for (let j = 0; j < 3; ++j) {
          sum += transform[j * 4 + i] * worldPeriodSubspace[j];
        }
        worldPeriodDisplay[i] = sum;
      }
    }

    this.vertexIdHelper.disable();
    const axisX = vec3.create();
    const axisY = vec3.create();
    axisX[si] = 1;
    axisY[sj] = 1;
    gl.uniform3fv(shader.uniform("uGeoChunkAxisX"), axisX);
    gl.uniform3fv(shader.uniform("uGeoChunkAxisY"), axisY);
    const chunkBase = vec3.create();
    const chunkDataDisplaySize = vec3.create();
    const { size } = chunkLayout;
    for (const chunkDim of chunkDisplayDimensionIndices) {
      fixedPositionWithinChunk[chunkDim] = 0;
    }
    let newSource = true;
    const drawMode = wireFrame
      ? WebGL2RenderingContext.LINES
      : WebGL2RenderingContext.TRIANGLES;
    let presentCount = 0;
    let notPresentCount = 0;
    beginGeoMeshFrame(transformedSource);
    const meshDeadline = performance.now() + GEO_MESH_BUILD_BUDGET_MS;
    let meshesDeferred = false;
    sliceView.forEachVisibleChunk(transformedSource, chunkLayout, (key) => {
      const chunk = chunks.get(key) as VolumeChunk | undefined;
      if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
        ++notPresentCount;
        return;
      }
      ++presentCount;
      const { chunkGridPosition, chunkDataSize } = chunk;
      const mesh = getGeoChunkMesh(
        transformedSource,
        chunkLayout,
        `${chunkGridPosition[chunkDimX]},${chunkGridPosition[chunkDimY]}`,
        chunkGridPosition[chunkDimX],
        chunkGridPosition[chunkDimY],
        si,
        sj,
        performance.now() < meshDeadline,
      );
      if (mesh === undefined) {
        // Exceeded the mesh computation budget for this frame.
        meshesDeferred = true;
        --presentCount;
        ++notPresentCount;
        return;
      }
      if (mesh.indices.length === 0) return;
      const gpuMesh = getGeoChunkGpuMesh(gl, mesh, staticTransform, si, sj);
      const copies = getGeoChunkMeshCopies(mesh, view);
      if (copies.length === 0) return;
      for (let i = 0; i < 3; ++i) {
        const chunkDim = chunkDisplayDimensionIndices[i];
        chunkDataDisplaySize[i] =
          chunkDim === -1 || chunkDim >= chunkRank
            ? 1
            : chunkDataSize[chunkDim];
      }
      gl.uniform3fv(shader.uniform("uChunkDataSize"), chunkDataDisplaySize);
      const chunkK =
        chunkDimK === -1 || chunkDimK >= chunkRank
          ? 0
          : chunkGridPosition[chunkDimK];
      chunkBase[sk] =
        thirdCoordinate - chunkK * size[sk] + CHUNK_POSITION_EPSILON;
      gl.uniform3fv(shader.uniform("uGeoChunkBase"), chunkBase);
      if (chunkFormat !== null) {
        chunkFormat.bindChunk(
          gl,
          shader,
          chunk,
          fixedPositionWithinChunk,
          chunkDisplayDimensionIndices,
          channelToChunkDimensionIndices,
          newSource,
        );
      }
      newSource = false;
      gpuMesh.position.bindToVertexAttrib(GEO_POSITION_ATTRIBUTE_LOCATION, 3);
      gpuMesh.positionLow.bindToVertexAttrib(
        GEO_POSITION_LOW_ATTRIBUTE_LOCATION,
        3,
      );
      gpuMesh.chunkPosition.bindToVertexAttrib(
        GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION,
        2,
      );
      const indexBuffer = wireFrame ? gpuMesh.getLines() : gpuMesh.triangles;
      indexBuffer.bind();
      const indexCount = wireFrame
        ? gpuMesh.numLineIndices
        : gpuMesh.numTriangleIndices;
      // Offset of the mesh origin relative to the center of the view, computed in double
      // precision.
      const { originX, originY } = gpuMesh;
      for (let c = 0; c < copies.length; c += 3) {
        const k = copies[c];
        const offset = [0, 0, 0];
        for (let i = 0; i < 3; ++i) {
          offset[i] =
            transform[si * 4 + i] * originX +
            transform[sj * 4 + i] * originY +
            transform[sk * 4 + i] * thirdCoordinate +
            transform[12 + i] -
            center[i] +
            k * worldPeriodDisplay[i];
        }
        const high0 = Math.fround(offset[0]);
        const high1 = Math.fround(offset[1]);
        const high2 = Math.fround(offset[2]);
        gl.uniform3f(shader.uniform("uGeoOffset"), high0, high1, high2);
        gl.uniform3f(
          shader.uniform("uGeoOffsetLow"),
          offset[0] - high0,
          offset[1] - high1,
          offset[2] - high2,
        );
        gl.drawElements(
          drawMode,
          indexCount,
          WebGL2RenderingContext.UNSIGNED_INT,
          0,
        );
      }
    });
    gl.disableVertexAttribArray(GEO_POSITION_ATTRIBUTE_LOCATION);
    gl.disableVertexAttribArray(GEO_POSITION_LOW_ATTRIBUTE_LOCATION);
    gl.disableVertexAttribArray(GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION);
    this.vertexIdHelper.enable();
    if (meshesDeferred) {
      // Draw the remaining chunks in the next frame.
      requestAnimationFrame(() => this.redrawNeeded.dispatch());
    }
    return [presentCount, notPresentCount];
  }

  private updateRenderScaleHistogram(
    transformedSource: FrontendTransformedSource,
    projectionParameters: ProjectionParameters & { pixelSize: number },
    presentCount: number,
    notPresentCount: number,
  ) {
    const { renderScaleHistogram } = this;
    if (
      (presentCount === 0 && notPresentCount === 0) ||
      renderScaleHistogram === undefined
    ) {
      return;
    }
    const { effectiveVoxelSize } = transformedSource;
    // TODO(jbms): replace median hack with more accurate estimate, e.g. based on ellipsoid
    // cross section.
    const medianVoxelSize = medianOf3(
      effectiveVoxelSize[0],
      effectiveVoxelSize[1],
      effectiveVoxelSize[2],
    );
    if (presentCount > 0) {
      const medianStoredVoxelSize = this.highestResolutionLoadedVoxelSize
        ? medianOf3(
            this.highestResolutionLoadedVoxelSize[0],
            this.highestResolutionLoadedVoxelSize[1],
            this.highestResolutionLoadedVoxelSize[2],
          )
        : Infinity;
      if (medianVoxelSize <= medianStoredVoxelSize) {
        this.highestResolutionLoadedVoxelSize = vec3.clone(effectiveVoxelSize);
      }
    }
    renderScaleHistogram.add(
      medianVoxelSize,
      medianVoxelSize / projectionParameters.pixelSize,
      presentCount,
      notPresentCount,
    );
  }

  draw(renderContext: SliceViewRenderContext) {
    const { sliceView } = renderContext;
    const layerInfo = sliceView.visibleLayers.get(this)!;
    const { visibleSources } = layerInfo;
    if (visibleSources.length === 0) {
      return;
    }

    const { projectionParameters, wireFrame } = renderContext;

    const { gl } = this;

    this.vertexIdHelper.enable();

    const chunkPosition = vec3.create();
    const { renderScaleHistogram } = this;

    if (renderScaleHistogram !== undefined) {
      renderScaleHistogram.begin(
        this.chunkManager.chunkQueueManager.frameNumberCounter.frameNumber,
      );
    }
    this.highestResolutionLoadedVoxelSize = undefined;

    let shaderResult: ParameterizedShaderGetterResult<
      ShaderParameters,
      ShaderContext
    >;
    let shader: ShaderProgram | null = null;
    let prevChunkFormat: ChunkFormat | undefined | null;
    let prevGeo = false;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const endShader = () => {
      if (shader === null) return;
      shader.unbindTransferFunctionTextures();
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
      }
      this.endSlice(sliceView, shader, shaderResult.parameters);
    };
    let newSource = true;
    for (const transformedSource of visibleSources) {
      const chunkLayout = getNormalizedChunkLayout(
        projectionParameters,
        transformedSource.chunkLayout,
      );
      const {
        chunkTransform: { channelToChunkDimensionIndices },
      } = transformedSource;
      const source = transformedSource.source as VolumeChunkSource;
      const { fixedPositionWithinChunk, chunkDisplayDimensionIndices } =
        transformedSource;
      for (const chunkDim of chunkDisplayDimensionIndices) {
        fixedPositionWithinChunk[chunkDim] = 0;
      }
      const chunkFormat = wireFrame ? null : source.chunkFormat;
      const geoMode = getGeoRenderingMode(
        transformedSource,
        projectionParameters,
        chunkLayout,
      );
      if (geoMode === GeoRenderingMode.HIDDEN) continue;
      const geo = geoMode === GeoRenderingMode.WARPED;
      if (chunkFormat !== prevChunkFormat || geo !== prevGeo) {
        prevChunkFormat = chunkFormat;
        prevGeo = geo;
        endShader();
        shaderResult = this.beginChunkFormat(
          sliceView,
          chunkFormat,
          projectionParameters,
          geo,
        );
        shader = shaderResult.shader;
      }
      if (shader === null) continue;
      if (geo) {
        if (chunkFormat !== null) {
          chunkFormat.beginSource(gl, shader);
        }
        const [presentCount, notPresentCount] = this.drawGeoSource(
          renderContext,
          shader,
          transformedSource,
          chunkLayout,
          chunkFormat,
        );
        this.updateRenderScaleHistogram(
          transformedSource,
          projectionParameters,
          presentCount,
          notPresentCount,
        );
        continue;
      }
      const chunks = source.chunks;

      chunkDataDisplaySize.fill(1);

      const originalChunkSize = chunkLayout.size;

      let chunkDataSize: Uint32Array | undefined;
      const chunkRank = source.spec.rank;

      beginSource(
        gl,
        shader,
        sliceView,
        projectionParameters.viewProjectionMat,
        transformedSource,
        chunkLayout,
      );
      if (chunkFormat !== null) {
        chunkFormat.beginSource(gl, shader);
      }
      newSource = true;
      let presentCount = 0;
      let notPresentCount = 0;
      sliceView.forEachVisibleChunk(transformedSource, chunkLayout, (key) => {
        const chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          const newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            chunkDataSize = newChunkDataSize;
            for (let i = 0; i < 3; ++i) {
              const chunkDim = chunkDisplayDimensionIndices[i];
              chunkDataDisplaySize[i] =
                chunkDim === -1 || chunkDim >= chunkRank
                  ? 1
                  : chunkDataSize[chunkDim];
            }
            setupChunkDataSize(gl, shader!, chunkDataDisplaySize);
          }
          const { chunkGridPosition } = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] =
              chunkDim === -1 || chunkDim >= chunkRank
                ? 0
                : originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          if (chunkFormat !== null) {
            chunkFormat.bindChunk(
              gl,
              shader!,
              chunk,
              fixedPositionWithinChunk,
              chunkDisplayDimensionIndices,
              channelToChunkDimensionIndices,
              newSource,
            );
          }
          newSource = false;
          drawChunk(gl, shader!, chunkPosition, wireFrame);
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      });
      this.updateRenderScaleHistogram(
        transformedSource,
        projectionParameters,
        presentCount,
        notPresentCount,
      );
    }
    endShader();
    this.vertexIdHelper.disable();
    if (!renderContext.wireFrame) {
      const dataHistogramCount = this.getDataHistogramCount();
      if (dataHistogramCount > 0) {
        sliceView.computeHistograms(
          dataHistogramCount,
          this.dataHistogramSpecifications,
        );
      }
    }
  }
}
