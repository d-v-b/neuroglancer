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
 * @file Rendering of the base ellipsoid of the globe view (see `src/geo/globe.ts`).
 */

import { makeEllipsoidMesh, splitDouble } from "#src/geo/globe.js";
import { RefCounted } from "#src/util/disposable.js";
import type { mat4 } from "#src/util/geom.js";
import { GLBuffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderModule, ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

/**
 * Defines the uniforms and vertex code shared by shaders that render geometry given in ECEF
 * coordinates split into high and low parts, relative to the camera target.
 */
export function defineGlobeRelativeToEyeShader(builder: ShaderBuilder) {
  builder.addUniform("highp vec3", "uTargetHigh");
  builder.addUniform("highp vec3", "uTargetLow");
  builder.addUniform("highp mat4", "uViewProjection");
  builder.addVertexCode(`
highp vec3 globeRenderPosition(highp vec3 high, highp vec3 low) {
  return (high - uTargetHigh) + (low - uTargetLow);
}
`);
}

const tempTargetHigh = new Float32Array(3);
const tempTargetLow = new Float32Array(3);

/**
 * Sets the uniforms defined by `defineGlobeRelativeToEyeShader`.
 */
export function setGlobeRelativeToEyeUniforms(
  gl: GL,
  shader: ShaderProgram,
  target: Float64Array,
  viewProjection: mat4,
) {
  splitDouble(target, tempTargetHigh, tempTargetLow);
  gl.uniform3fv(shader.uniform("uTargetHigh"), tempTargetHigh);
  gl.uniform3fv(shader.uniform("uTargetLow"), tempTargetLow);
  gl.uniformMatrix4fv(shader.uniform("uViewProjection"), false, viewProjection);
}

const ELLIPSOID_NUM_LON = 256;
const ELLIPSOID_NUM_LAT = 128;

/**
 * Renders the WGS84 ellipsoid with a latitude/longitude graticule, as the background of the globe
 * view where no imagery is shown.
 */
export class GlobeBaseRenderer extends RefCounted {
  private positionHigh: GLBuffer;
  private positionLow: GLBuffer;
  private lonLat: GLBuffer;
  private indices: GLBuffer;
  private numIndices: number;
  private shaders = new Map<ShaderModule, ShaderProgram>();

  constructor(public gl: GL) {
    super();
    const mesh = makeEllipsoidMesh(ELLIPSOID_NUM_LON, ELLIPSOID_NUM_LAT);
    this.positionHigh = this.registerDisposer(GLBuffer.fromData(gl, mesh.high));
    this.positionLow = this.registerDisposer(GLBuffer.fromData(gl, mesh.low));
    this.lonLat = this.registerDisposer(GLBuffer.fromData(gl, mesh.lonLat));
    this.indices = this.registerDisposer(
      GLBuffer.fromData(
        gl,
        mesh.indices,
        WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER,
      ),
    );
    this.numIndices = mesh.indices.length;
  }

  static get(gl: GL) {
    return gl.memoize.get("GlobeBaseRenderer", () => new GlobeBaseRenderer(gl));
  }

  private getShader(emitter: ShaderModule) {
    let shader = this.shaders.get(emitter);
    if (shader === undefined) {
      const builder = new ShaderBuilder(this.gl);
      defineGlobeRelativeToEyeShader(builder);
      builder.require(emitter);
      builder.addAttribute("highp vec3", "aPositionHigh");
      builder.addAttribute("highp vec3", "aPositionLow");
      builder.addAttribute("highp vec2", "aLonLat");
      builder.addUniform("highp vec3", "uEye");
      builder.addVarying("highp vec2", "vLonLat");
      builder.addVarying("highp vec3", "vNormal");
      builder.addVarying("highp vec3", "vPosition");
      builder.setVertexMain(`
vec3 p = globeRenderPosition(aPositionHigh, aPositionLow);
vPosition = p;
vLonLat = aLonLat;
float lambda = radians(aLonLat.x);
float phi = radians(aLonLat.y);
vNormal = vec3(cos(phi) * cos(lambda), cos(phi) * sin(lambda), sin(phi));
gl_Position = uViewProjection * vec4(p, 1.0);
`);
      builder.addFragmentCode(`
float graticuleLine(float value, float spacing, float width) {
  float d = abs(fract(value / spacing + 0.5) - 0.5) * spacing;
  float w = fwidth(value) * width;
  return 1.0 - smoothstep(0.0, w, d);
}
`);
      builder.setFragmentMain(`
vec3 base = vec3(0.07, 0.13, 0.24);
float lambert = max(0.0, dot(normalize(vNormal), normalize(uEye - vPosition)));
vec3 color = base * (0.35 + 0.65 * lambert);
float minor = max(graticuleLine(vLonLat.x, 10.0, 1.0), graticuleLine(vLonLat.y, 10.0, 1.0));
float major = max(graticuleLine(vLonLat.x, 30.0, 1.5), graticuleLine(vLonLat.y, 30.0, 1.5));
color = mix(color, vec3(0.45, 0.6, 0.75), 0.25 * minor);
color = mix(color, vec3(0.6, 0.75, 0.9), 0.45 * major);
emit(vec4(color, 1.0), 0u);
`);
      shader = builder.build();
      this.shaders.set(emitter, shader);
    }
    return shader;
  }

  /**
   * Draws the ellipsoid.
   *
   * @param target ECEF coordinates of the camera target (origin of render coordinates).
   * @param eye Render coordinates of the camera.
   * @param viewProjection Transform from render coordinates to clip coordinates.
   */
  draw(
    emitter: ShaderModule,
    target: Float64Array,
    eye: ArrayLike<number>,
    viewProjection: mat4,
  ) {
    const { gl } = this;
    const shader = this.getShader(emitter);
    shader.bind();
    setGlobeRelativeToEyeUniforms(gl, shader, target, viewProjection);
    gl.uniform3f(shader.uniform("uEye"), eye[0], eye[1], eye[2]);
    const aPositionHigh = shader.attribute("aPositionHigh");
    const aPositionLow = shader.attribute("aPositionLow");
    const aLonLat = shader.attribute("aLonLat");
    this.positionHigh.bindToVertexAttrib(aPositionHigh, 3);
    this.positionLow.bindToVertexAttrib(aPositionLow, 3);
    this.lonLat.bindToVertexAttrib(aLonLat, 2);
    this.indices.bind();
    gl.drawElements(
      WebGL2RenderingContext.TRIANGLES,
      this.numIndices,
      WebGL2RenderingContext.UNSIGNED_INT,
      0,
    );
    gl.disableVertexAttribArray(aPositionHigh);
    gl.disableVertexAttribArray(aPositionLow);
    gl.disableVertexAttribArray(aLonLat);
  }
}
