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

// Decodes a JPEG XR file (ITU-T T.832 with its container) with jxrlib, to
// the pixel layout `imagecodecs.jpegxr_decode` gives: rows of interleaved
// samples, color in R, G, B (A) order.
//
// `jpegxr_decode` returns a malloc'd block: a header of six little-endian
// u32 (width, height, samples per pixel, bytes per sample, sample kind,
// body length) and the body. Sample kind 0 is unsigned integer, 1 is IEEE
// float. On error the width is 0 and the body is a message.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <JXRGlue.h>

enum { HEADER = 24, KIND_UINT = 0, KIND_FLOAT = 1 };

typedef struct {
  const PKPixelFormatGUID *input;
  const PKPixelFormatGUID *output;
  uint32_t samples;
  uint32_t bytesPerSample;
  uint32_t kind;
  uint8_t alphaMode;
} FormatInfo;

// The formats of CZI JpgXr subblocks (Gray8, Gray16, Gray32Float, Bgr24,
// Bgr48, Bgr96Float, Bgra32) and their close relatives, converted as
// imagecodecs converts them.
static const FormatInfo FORMATS[] = {
    {&GUID_PKPixelFormat8bppGray, &GUID_PKPixelFormat8bppGray, 1, 1, KIND_UINT, 0},
    {&GUID_PKPixelFormat16bppGray, &GUID_PKPixelFormat16bppGray, 1, 2, KIND_UINT, 0},
    {&GUID_PKPixelFormat32bppGrayFloat, &GUID_PKPixelFormat32bppGrayFloat, 1, 4, KIND_FLOAT, 0},
    {&GUID_PKPixelFormat24bppRGB, &GUID_PKPixelFormat24bppRGB, 3, 1, KIND_UINT, 0},
    {&GUID_PKPixelFormat24bppBGR, &GUID_PKPixelFormat24bppRGB, 3, 1, KIND_UINT, 0},
    {&GUID_PKPixelFormat32bppRGB, &GUID_PKPixelFormat24bppRGB, 3, 1, KIND_UINT, 0},
    {&GUID_PKPixelFormat48bppRGB, &GUID_PKPixelFormat48bppRGB, 3, 2, KIND_UINT, 0},
    {&GUID_PKPixelFormat96bppRGBFloat, &GUID_PKPixelFormat96bppRGBFloat, 3, 4, KIND_FLOAT, 0},
    {&GUID_PKPixelFormat128bppRGBFloat, &GUID_PKPixelFormat96bppRGBFloat, 3, 4, KIND_FLOAT, 0},
    {&GUID_PKPixelFormat32bppBGRA, &GUID_PKPixelFormat32bppRGBA, 4, 1, KIND_UINT, 2},
    {&GUID_PKPixelFormat32bppRGBA, &GUID_PKPixelFormat32bppRGBA, 4, 1, KIND_UINT, 2},
    {&GUID_PKPixelFormat64bppRGBA, &GUID_PKPixelFormat64bppRGBA, 4, 2, KIND_UINT, 2},
    {&GUID_PKPixelFormat128bppRGBAFloat, &GUID_PKPixelFormat128bppRGBAFloat, 4, 4, KIND_FLOAT, 2},
};

static uint8_t *error_result(const char *message) {
  size_t length = strlen(message);
  uint8_t *result = malloc(HEADER + length);
  if (result == NULL) return NULL;
  uint32_t header[6] = {0, 0, 0, 0, 0, (uint32_t)length};
  memcpy(result, header, HEADER);
  memcpy(result + HEADER, message, length);
  return result;
}

uint8_t *jpegxr_decode(uint8_t *data, size_t size) {
  const PKIID *iid = NULL;
  struct WMPStream *stream = NULL;
  PKImageDecode *decoder = NULL;
  PKFormatConverter *converter = NULL;
  uint8_t *result = NULL;
  const char *message = NULL;
  PKPixelFormatGUID format;
  I32 width = 0, height = 0;
  const FormatInfo *info = NULL;

  if (GetImageDecodeIID(".jxr", &iid) != WMP_errSuccess ||
      CreateWS_Memory(&stream, data, size) != WMP_errSuccess) {
    message = "cannot create a decoder";
    goto done;
  }
  if (PKCodecFactory_CreateCodec(iid, (void **)&decoder) != WMP_errSuccess) {
    message = "cannot create a decoder";
    goto done;
  }
  if (decoder->Initialize(decoder, stream) != WMP_errSuccess) {
    message = "invalid JPEG XR file";
    goto done;
  }
  decoder->fStreamOwner = 1;
  stream = NULL;
  if (PKImageDecode_GetSize(decoder, &width, &height) != WMP_errSuccess ||
      PKImageDecode_GetPixelFormat(decoder, &format) != WMP_errSuccess ||
      width <= 0 || height <= 0) {
    message = "invalid JPEG XR file";
    goto done;
  }
  for (size_t i = 0; i < sizeof(FORMATS) / sizeof(FORMATS[0]); ++i) {
    if (IsEqualGUID(&format, FORMATS[i].input)) {
      info = &FORMATS[i];
      break;
    }
  }
  if (info == NULL) {
    message = "unsupported JPEG XR pixel format";
    goto done;
  }
  decoder->WMP.wmiSCP.uAlphaMode = info->alphaMode;
  if (PKCodecFactory_CreateFormatConverter(&converter) != WMP_errSuccess ||
      PKFormatConverter_Initialize(converter, decoder, NULL, *info->output) !=
          WMP_errSuccess) {
    message = "unsupported JPEG XR pixel format conversion";
    goto done;
  }
  {
    uint32_t stride = (uint32_t)width * info->samples * info->bytesPerSample;
    uint32_t length = stride * (uint32_t)height;
    result = malloc(HEADER + length);
    if (result == NULL) goto done;
    PKRect rect = {0, 0, width, height};
    if (PKFormatConverter_Copy(converter, &rect, result + HEADER, stride) !=
        WMP_errSuccess) {
      free(result);
      result = NULL;
      message = "corrupt JPEG XR data";
      goto done;
    }
    uint32_t header[6] = {(uint32_t)width, (uint32_t)height, info->samples,
                          info->bytesPerSample, info->kind, length};
    memcpy(result, header, HEADER);
  }

done:
  if (converter != NULL) PKFormatConverter_Release(&converter);
  if (decoder != NULL) PKImageDecode_Release(&decoder);
  if (stream != NULL) stream->Close(&stream);
  if (message != NULL) return error_result(message);
  return result;
}
