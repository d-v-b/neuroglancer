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

import { describe, expect, it } from "vitest";
import { convertAnnotationsToEcef } from "#src/annotation/globe.js";
import type { AnnotationPropertySpec } from "#src/annotation/index.js";
import {
  AnnotationSerializer,
  AnnotationType,
  makeAnnotationPropertySerializers,
} from "#src/annotation/index.js";

describe("convertAnnotationsToEcef", () => {
  it("replaces positions with ECEF coordinates and preserves properties", () => {
    const rank = 4;
    const properties: AnnotationPropertySpec[] = [
      {
        type: "float32",
        identifier: "mag",
        default: 0,
        description: undefined,
      },
    ];
    const serializers = makeAnnotationPropertySerializers(rank, properties);
    const serializer = new AnnotationSerializer(serializers);
    serializer.add({
      type: AnnotationType.POINT,
      id: "a",
      point: Float32Array.of(1, 2, 3, 7),
      properties: [5.5],
    });
    serializer.add({
      type: AnnotationType.POINT,
      id: "invalid",
      point: Float32Array.of(1, 2, 9, 7),
      properties: [6],
    });
    serializer.add({
      type: AnnotationType.POLYLINE,
      id: "b",
      points: [
        Float32Array.of(0, 1, 1, 7),
        Float32Array.of(0, 2, 1, 7),
        Float32Array.of(0, 3, 1, 7),
      ],
      properties: [1],
    });
    const serialized = serializer.serialize();
    // Model dimensions 1, 2, 3 are displayed (as display dimensions 0, 1, 2), with global
    // dimensions 2, 0, 1 and a translation of 100 along display dimension 0.
    const renderSubspaceTransform = new Float32Array(rank * 3);
    renderSubspaceTransform[1 * 3 + 0] = 1;
    renderSubspaceTransform[2 * 3 + 1] = 1;
    renderSubspaceTransform[3 * 3 + 2] = 1;
    const displaySubspaceModelMatrix = Float32Array.of(
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      100,
      0,
      0,
      1,
    );
    const converted = convertAnnotationsToEcef(serialized, serializers, rank, {
      renderSubspaceTransform,
      displaySubspaceModelMatrix,
      displayDimensionIndices: [2, 0, 1],
      globalPosition: [0, 0, 0],
      globalToEcef(g, out) {
        out[0] = g[0];
        out[1] = g[1];
        out[2] = g[2];
        return g[0] < 5;
      },
    });
    expect(converted).not.toBe(serialized.data);
    const f32 = (offset: number) =>
      new DataView(converted.buffer).getFloat32(offset, true);
    const pointStride = serializers[AnnotationType.POINT].propertyGroupBytes[0];
    const pointOffset = serialized.typeToOffset[AnnotationType.POINT];
    // Global position: [model[2], model[3], model[1] + 100].
    expect([0, 1, 2].map((k) => f32(pointOffset + 4 * k))).toEqual([3, 7, 102]);
    // The remaining model coordinate and the properties are unchanged.
    expect(f32(pointOffset + 12)).toBe(7);
    expect(f32(pointOffset + 16)).toBeCloseTo(5.5);
    // Positions that cannot be converted are replaced by NaN.
    expect(f32(pointOffset + pointStride)).toBeNaN();
    // Both positions of each polyline segment are converted.
    const lineStride =
      serializers[AnnotationType.POLYLINE].propertyGroupBytes[0];
    const lineOffset = serialized.typeToOffset[AnnotationType.POLYLINE];
    for (let segment = 0; segment < 2; ++segment) {
      const offset = lineOffset + segment * lineStride + 4;
      expect([0, 1, 2].map((k) => f32(offset + 4 * k))).toEqual([
        1,
        7,
        101 + segment,
      ]);
      expect([0, 1, 2].map((k) => f32(offset + 4 * rank + 4 * k))).toEqual([
        1,
        7,
        102 + segment,
      ]);
    }
  });
});
