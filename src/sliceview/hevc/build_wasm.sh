#!/bin/bash -xve

LIBDE265=${LIBDE265:-/usr/src/libde265}
BUILD=${BUILD:-/tmp/libde265-build}

# The library alone, static, single-threaded (no worker threads are started,
# and emscripten's pthread functions without -pthread are stubs), without the
# SIMD kernels (SSE, NEON: neither is wasm), with its assertions kept: a
# failed one traps, and `index.ts` then discards the instance.
emcmake cmake -S "$LIBDE265" -B "$BUILD" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_FLAGS_RELEASE=-O2 \
        -DCMAKE_CXX_FLAGS_RELEASE=-O2 \
        -DBUILD_SHARED_LIBS=OFF \
        -DENABLE_SDL=OFF \
        -DENABLE_SIMD=OFF \
        -DENABLE_DECODER=OFF \
        -DENABLE_ENCODER=OFF \
        -DENABLE_SHERLOCK265=OFF
cmake --build "$BUILD" --target de265 -j"$(nproc)"

compile_options=(
    -O2
    -I"$LIBDE265" -I"$BUILD"
    hevc_wasm.c
    "$BUILD"/libde265/libde265.a
    --no-entry
    -s FILESYSTEM=0
    -s ALLOW_MEMORY_GROWTH=1
    -s MAXIMUM_MEMORY=4gb
    -s TOTAL_STACK=1mb
    -s TOTAL_MEMORY=16mb
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_hevc_new","_hevc_free","_hevc_push_nal","_hevc_flush","_hevc_decode","_hevc_warning","_hevc_error_text","_hevc_next_picture","_hevc_picture_info","_hevc_plane"]'
    -s MALLOC=emmalloc
    -s ENVIRONMENT=worker
    -s STANDALONE_WASM=1
    -o libde265.wasm
)
emcc "${compile_options[@]}"
