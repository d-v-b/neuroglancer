/* tslint:disable */
/* eslint-disable */

/**
 * Decodes an `htj2k` chunk back to little-endian elements in C order.
 */
export function htj2k_decode(chunk: Uint8Array, shape: Uint32Array, dtype: string): Uint8Array;

/**
 * Encodes a chunk (little-endian elements, C order, trailing dims
 * `(y, x)`) into the `htj2k` container. `config_json` is the Zarr v3
 * `configuration` object (`{}` for the defaults).
 */
export function htj2k_encode(chunk: Uint8Array, shape: Uint32Array, dtype: string, config_json: string): Uint8Array;

/**
 * Decodes an `nd_lift` coefficient plane back to little-endian `dtype`
 * elements in C order.
 */
export function nd_lift_decode(chunk: Uint8Array, shape: Uint32Array, dtype: string, config_json: string): Uint8Array;

/**
 * Encodes a chunk (little-endian elements, C order) into its widened,
 * decorrelated `nd_lift` coefficient plane (little-endian `int32` or
 * `int64`). `config_json` is the Zarr v3 `configuration` object.
 */
export function nd_lift_encode(chunk: Uint8Array, shape: Uint32Array, dtype: string, config_json: string): Uint8Array;

/**
 * Decodes a `zfp` chunk back to little-endian elements in C order.
 * The stream's header must match the configuration in `config_json`.
 */
export function nd_zfp_decode(chunk: Uint8Array, shape: Uint32Array, dtype: string, config_json: string): Uint8Array;

/**
 * Encodes a chunk (little-endian elements, C order) into a `zfp` ZFP
 * stream. `config_json` is the Zarr v3 `configuration` object (`{}` for
 * the defaults; a legacy `dims` member selects the old `nd_zfp` chunk
 * mapping).
 */
export function nd_zfp_encode(chunk: Uint8Array, shape: Uint32Array, dtype: string, config_json: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly htj2k_decode: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly htj2k_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly nd_lift_decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly nd_lift_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly nd_zfp_decode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly nd_zfp_encode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
