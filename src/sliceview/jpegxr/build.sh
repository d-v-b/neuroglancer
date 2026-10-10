#!/bin/bash -xve

# This script builds `jpegxr.wasm` using emsdk in a docker container.
# Without docker, run `JXRLIB=<jxrlib checkout> ./build_wasm.sh` with
# emscripten 4.0.15 (`emcc`) on the path.

cd "$(dirname "$0")"

docker build .
docker run \
       --rm \
       -v ${PWD}:/src \
       -u $(id -u):$(id -g) \
       $(docker build -q .) \
       ./build_wasm.sh
