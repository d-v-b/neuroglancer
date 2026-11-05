#!/bin/bash -xve

# Rebuilds `ndic_zarr.js` and `ndic_zarr_bg.wasm` from nd-image-codecs v0.2.5
# (https://github.com/fideus-labs/nd-image-codecs, tag v0.2.5, commit
# 4d17357f83e48b2031dd075328431fd280c8e2ac) with a local Rust toolchain:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack wasm-bindgen-cli --version 0.2.126   # must match Cargo.lock
#   ./build.sh
# `wasm-opt` (binaryen) is used by wasm-pack if it is installed. The same toolchain is
# available from conda-forge: rust, rust-std-wasm32-unknown-unknown, wasm-pack,
# wasm-bindgen-cli=0.2.126, binaryen.

cd "$(dirname "$0")"
OUT="$PWD"
WORK="$(mktemp -d)"
git clone --quiet https://github.com/fideus-labs/nd-image-codecs.git "$WORK/nd-image-codecs"
git -C "$WORK/nd-image-codecs" checkout --quiet 4d17357f83e48b2031dd075328431fd280c8e2ac
(
  cd "$WORK/nd-image-codecs"
  wasm-pack build crates/ndic-zarr --target web --release --out-dir "$WORK/out" -- --features wasm --locked
)
cp "$WORK/out/ndic_zarr.js" "$WORK/out/ndic_zarr.d.ts" "$WORK/out/ndic_zarr_bg.wasm" "$OUT/"
cp "$WORK/nd-image-codecs/LICENSE.txt" "$OUT/LICENSE.nd-image-codecs"
rm -rf "$WORK"
