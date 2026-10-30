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
 * @file Registers the resolver of every supported codec. The frontend
 * resolves an array's codecs once; the backend resolves them again for
 * each distinct chunk shape of a rectilinear chunk grid.
 */

import "#src/datasource/zarr/codec/blosc/resolve.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/crc32c/resolve.js";
import "#src/datasource/zarr/codec/gzip/resolve.js";
import "#src/datasource/zarr/codec/jpeg/resolve.js";
import "#src/datasource/zarr/codec/jpeg2k/resolve.js";
import "#src/datasource/zarr/codec/jpegxr/resolve.js";
import "#src/datasource/zarr/codec/ljpeg/resolve.js";
import "#src/datasource/zarr/codec/lzw/resolve.js";
import "#src/datasource/zarr/codec/n5_default/resolve.js";
import "#src/datasource/zarr/codec/numcodecs_shuffle/resolve.js";
import "#src/datasource/zarr/codec/refkv_fits_tiles/resolve.js";
import "#src/datasource/zarr/codec/refkv_grib/resolve.js";
import "#src/datasource/zarr/codec/refkv_skip/resolve.js";
import "#src/datasource/zarr/codec/refkv_stream/resolve.js";
import "#src/datasource/zarr/codec/sharding_indexed/resolve.js";
import "#src/datasource/zarr/codec/transpose/resolve.js";
import "#src/datasource/zarr/codec/zstd/resolve.js";
