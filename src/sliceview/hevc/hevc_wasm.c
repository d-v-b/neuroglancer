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

// A thin layer over libde265's C API (libde265/de265.h) of int32 arguments
// and results, for `index.ts`: NAL units are pushed, the decoder is stepped
// and the pictures it gives are read one at a time, each until the next call.

#include <stdint.h>
#include <stdlib.h>

#include <libde265/de265.h>

// A decoder, in this thread only, that checks a picture's SEI hash when the
// stream has one (an error, DE265_ERROR_CHECKSUM_MISMATCH, when it differs).
de265_decoder_context *hevc_new(void) {
  de265_decoder_context *ctx = de265_new_decoder();
  if (ctx != NULL) {
    de265_set_parameter_bool(ctx, DE265_DECODER_PARAM_BOOL_SEI_CHECK_HASH, 1);
  }
  return ctx;
}

void hevc_free(de265_decoder_context *ctx) { de265_free_decoder(ctx); }

// Queues a NAL unit, without its start code or length; the decoder copies it.
// The picture it is a slice of is given the timestamp `pts`.
int hevc_push_nal(de265_decoder_context *ctx, const uint8_t *data, int length,
                  int pts) {
  return de265_push_NAL(ctx, data, length, pts, NULL);
}

// Marks the end of the stream: the pictures held for reordering are given.
int hevc_flush(de265_decoder_context *ctx) { return de265_flush_data(ctx); }

// Decodes one NAL unit, or flushes; `*more` is whether there is more to do.
int hevc_decode(de265_decoder_context *ctx, int *more) {
  return de265_decode(ctx, more);
}

// The next warning of the decoder's, or 0 (DE265_OK) when there is none.
int hevc_warning(de265_decoder_context *ctx) { return de265_get_warning(ctx); }

const char *hevc_error_text(int error) {
  return de265_get_error_text((de265_error)error);
}

// The next picture in output order, or NULL; valid until the next call.
const de265_image *hevc_next_picture(de265_decoder_context *ctx) {
  return de265_get_next_picture(ctx);
}

// The picture's timestamp, chroma format (0 for 4:0:0, 1 for 4:2:0, 2 for
// 4:2:2, 3 for 4:4:4), and its luma's width, height and bits a sample, in
// `info[0..4]`.
void hevc_picture_info(const de265_image *img, int32_t *info) {
  info[0] = (int32_t)de265_get_image_PTS(img);
  info[1] = (int32_t)de265_get_chroma_format(img);
  info[2] = de265_get_image_width(img, 0);
  info[3] = de265_get_image_height(img, 0);
  info[4] = de265_get_bits_per_pixel(img, 0);
}

// The address of a plane's first sample (0 Y, 1 U, 2 V) of the picture's
// conformance window, and its width, height, stride in bytes and bits a
// sample in `info[0..3]` (samples of more than 8 bits are little-endian
// uint16).
const uint8_t *hevc_plane(const de265_image *img, int channel, int32_t *info) {
  int stride = 0;
  const uint8_t *plane = de265_get_image_plane(img, channel, &stride);
  info[0] = de265_get_image_width(img, channel);
  info[1] = de265_get_image_height(img, channel);
  info[2] = stride;
  info[3] = de265_get_bits_per_pixel(img, channel);
  return plane;
}
