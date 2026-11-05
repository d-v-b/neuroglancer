# nd-image-codecs WebAssembly

`ndic_zarr_bg.wasm` and its `wasm-bindgen` glue (`ndic_zarr.js`, `ndic_zarr.d.ts`) implement the Zarr v3
codecs `htj2k` (HTJ2K coefficient planes with a plane index) and `nd_lift` (reversible lifting along z/t/c)
of [nd-image-codecs](https://github.com/fideus-labs/nd-image-codecs) (MIT, see `LICENSE.nd-image-codecs`).

- Source: tag `v0.2.5`, commit `4d17357f83e48b2031dd075328431fd280c8e2ac`, crate `ndic-zarr` with `--features wasm`
  (`wasm-pack build --target web --release --locked`, rustc 1.99.1, wasm-bindgen 0.2.126, wasm-opt from binaryen 121).
- Rebuild with `./build.sh`.
- `ndic_zarr_bg.wasm` is 504,626 bytes, sha256 `0a52563eb0ab1bb7aa11991ce579b6856f98ff3852619a7e302cb0117c2d176f`.
- The module also exports the `nd_zfp` codec and the encoders; Neuroglancer uses only `htj2k_decode` and `nd_lift_decode`.
