#!/bin/bash -xve

# This script builds `libde265.wasm` using emsdk in a docker container.
# Without docker, run `LIBDE265=<libde265 checkout> ./build_wasm.sh` with
# emscripten 4.0.15 (`emcc`, `emcmake`) on the path.

cd "$(dirname "$0")"

docker build .
docker run \
       --rm \
       -v ${PWD}:/src \
       -u $(id -u):$(id -g) \
       $(docker build -q .) \
       ./build_wasm.sh
