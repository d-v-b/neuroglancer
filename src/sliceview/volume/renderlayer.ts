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
const GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION = 2;

/**
 * Defines the vertex shader for rendering georeferenced sources, which are drawn as triangle meshes
 * computed on the CPU (see `src/sliceview/geo.ts`) rather than as box-plane intersections.
 */
function defineGeoVolumeShader(builder: ShaderBuilder, wireFrame: boolean) {
  // Display position of the vertex relative to the center of the view.
  builder.addAttribute(
    "highp vec3",
    "aGeoPosition",
    GEO_POSITION_ATTRIBUTE_LOCATION,
  );
  // Position within the chunk along the two georeferenced chunk dimensions.
  builder.addAttribute(
    "highp vec2",
    "aGeoChunkPosition",
    GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION,
  );
  builder.addUniform("highp mat4", "uProjectionMatrix");
  // Display offset of the current world copy.
  builder.addUniform("highp vec3", "uGeoOffset");
  builder.addUniform("highp vec3", "uGeoChunkAxisX");
  builder.addUniform("highp vec3", "uGeoChunkAxisY");
  builder.addUniform("highp vec3", "uGeoChunkBase");
  builder.addUniform("highp vec3", "uChunkDataSize");
  if (wireFrame) {
    builder.setVertexMain(`
gl_Position = uProjectionMatrix * vec4(aGeoPosition + uGeoOffset, 1.0);
gl_Position.z = 0.0;
`);
    builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, 0.5));
`);
    return;
  }
  builder.addVarying("highp vec3", "vChunkPosition");
  builder.setVertexMain(`
gl_Position = uProjectionMatrix * vec4(aGeoPosition + uGeoOffset, 1.0);
gl_Position.z = 0.0;
vChunkPosition = uGeoChunkBase + aGeoChunkPosition.x * uGeoChunkAxisX +
    aGeoChunkPosition.y * uGeoChunkAxisY;
`);
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

  getValueAt(globalPosition: Float32Array) {
    const { tempChunkPosition } = this;
    for (const { source, chunkTransform, geoWarp } of this.visibleSourcesList) {
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
        !correctGeoChunkPosition(geoWarp, tempChunkPosition)
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

  private geoBuffers:
    | { position: GLBuffer; chunkPosition: GLBuffer; index: GLBuffer }
    | undefined;

  private getGeoBuffers() {
    let buffers = this.geoBuffers;
    if (buffers === undefined) {
      const { gl } = this;
      buffers = this.geoBuffers = {
        position: new GLBuffer(gl),
        chunkPosition: new GLBuffer(gl),
        index: new GLBuffer(gl, WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER),
      };
      this.registerDisposer(() => {
        buffers!.position.dispose();
        buffers!.chunkPosition.dispose();
        buffers!.index.dispose();
      });
    }
    return buffers;
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

    // Collect the visible chunks that are in GPU memory.
    const drawChunks: VolumeChunk[] = [];
    const meshes: GeoChunkMesh[] = [];
    let notPresentCount = 0;
    let totalVertices = 0;
    let totalIndices = 0;
    sliceView.forEachVisibleChunk(transformedSource, chunkLayout, (key) => {
      const chunk = chunks.get(key);
      if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) {
        ++notPresentCount;
        return;
      }
      const { chunkGridPosition } = chunk;
      const mesh = getGeoChunkMesh(
        transformedSource,
        chunkLayout,
        `${chunkGridPosition[chunkDimX]},${chunkGridPosition[chunkDimY]}`,
        chunkGridPosition[chunkDimX],
        chunkGridPosition[chunkDimY],
        si,
        sj,
      );
      if (mesh.indices.length === 0) return;
      drawChunks.push(chunk as VolumeChunk);
      meshes.push(mesh);
      totalVertices += mesh.numVertices;
      totalIndices += wireFrame ? mesh.indices.length * 2 : mesh.indices.length;
    });
    const presentCount = drawChunks.length;
    if (presentCount === 0) return [presentCount, notPresentCount];

    // Compute vertex positions relative to the center of the view, in double precision, to avoid
    // loss of precision for large display coordinates.
    const { transform } = chunkLayout;
    const { invViewMatrix, viewProjectionMat } = projectionParameters;
    const center = [invViewMatrix[12], invViewMatrix[13], invViewMatrix[14]];
    const offset = [0, 0, 0];
    for (let i = 0; i < 3; ++i) {
      offset[i] =
        transform[sk * 4 + i] * thirdCoordinate + transform[12 + i] - center[i];
    }
    const tx = [
      transform[si * 4],
      transform[si * 4 + 1],
      transform[si * 4 + 2],
    ];
    const ty = [
      transform[sj * 4],
      transform[sj * 4 + 1],
      transform[sj * 4 + 2],
    ];
    const positions = new Float32Array(totalVertices * 3);
    const chunkPositions = new Float32Array(totalVertices * 2);
    const indices = new Uint32Array(totalIndices);
    const indexOffsets: number[] = [];
    {
      let vertexOffset = 0;
      let indexOffset = 0;
      for (const mesh of meshes) {
        const { warped, numVertices } = mesh;
        for (let v = 0; v < numVertices; ++v) {
          const wx = warped[2 * v];
          const wy = warped[2 * v + 1];
          const base = (vertexOffset + v) * 3;
          for (let i = 0; i < 3; ++i) {
            positions[base + i] = tx[i] * wx + ty[i] * wy + offset[i];
          }
        }
        chunkPositions.set(mesh.positionWithinChunk, vertexOffset * 2);
        indexOffsets.push(indexOffset);
        const meshIndices = mesh.indices;
        if (wireFrame) {
          for (let t = 0, n = meshIndices.length; t < n; t += 3) {
            const a = meshIndices[t] + vertexOffset;
            const b = meshIndices[t + 1] + vertexOffset;
            const c = meshIndices[t + 2] + vertexOffset;
            indices[indexOffset++] = a;
            indices[indexOffset++] = b;
            indices[indexOffset++] = b;
            indices[indexOffset++] = c;
            indices[indexOffset++] = c;
            indices[indexOffset++] = a;
          }
        } else {
          for (let t = 0, n = meshIndices.length; t < n; ++t) {
            indices[indexOffset++] = meshIndices[t] + vertexOffset;
          }
        }
        vertexOffset += numVertices;
      }
      indexOffsets.push(indexOffset);
    }
    const buffers = this.getGeoBuffers();
    buffers.position.setData(positions, WebGL2RenderingContext.STREAM_DRAW);
    buffers.chunkPosition.setData(
      chunkPositions,
      WebGL2RenderingContext.STREAM_DRAW,
    );
    buffers.index.setData(indices, WebGL2RenderingContext.STREAM_DRAW);

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
    buffers.position.bindToVertexAttrib(GEO_POSITION_ATTRIBUTE_LOCATION, 3);
    buffers.chunkPosition.bindToVertexAttrib(
      GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION,
      2,
    );
    buffers.index.bind();

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
    for (let chunkIndex = 0; chunkIndex < presentCount; ++chunkIndex) {
      const chunk = drawChunks[chunkIndex];
      const mesh = meshes[chunkIndex];
      const { chunkDataSize, chunkGridPosition } = chunk;
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
      const indexStart = indexOffsets[chunkIndex];
      const indexCount = indexOffsets[chunkIndex + 1] - indexStart;
      const copies = getGeoChunkMeshCopies(mesh, view);
      for (let c = 0; c < copies.length; c += 3) {
        const k = copies[c];
        gl.uniform3f(
          shader.uniform("uGeoOffset"),
          k * worldPeriodDisplay[0],
          k * worldPeriodDisplay[1],
          k * worldPeriodDisplay[2],
        );
        gl.drawElements(
          drawMode,
          indexCount,
          WebGL2RenderingContext.UNSIGNED_INT,
          indexStart * 4,
        );
      }
    }
    gl.disableVertexAttribArray(GEO_POSITION_ATTRIBUTE_LOCATION);
    gl.disableVertexAttribArray(GEO_CHUNK_POSITION_ATTRIBUTE_LOCATION);
    this.vertexIdHelper.enable();
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
        this.highestResolutionLoadedVoxelSize = effectiveVoxelSize;
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
