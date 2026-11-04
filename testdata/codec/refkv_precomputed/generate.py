"""Writes the fixtures of tests/codec/refkv_precomputed.browser_test.ts: refkv's synthetic
precomputed volumes (https://github.com/d-v-b/refkv, fixtures/precomputed/, MIT OR Apache-2.0),
zarrified by refkv and written out as plain Zarr v3 stores. Run with refkv's own environment, so
that its zarrifier and its Python codec are the ones the fixtures come from:

    cd <refkv> && uv run python <here>/generate.py

For each volume, <name>/<n>/ is array <n>, each of its Zarr chunks as refkv's reader resolves it
(the position, then the whole object), and <name>/<n>.expected is the array as refkv's Python codec
reads it, in the array's order, little-endian.
"""

import asyncio
import shutil
import tempfile
from pathlib import Path

import refkv
import zarr
from obstore.store import LocalStore
from refkv.zarr import store as zarr_store
from refkv.zarrify import zarrify_store
from zarr.core.buffer import default_buffer_prototype

HERE = Path(__file__).parent
FIXTURES = Path.cwd() / "fixtures" / "precomputed"
URL = "https://example.test/precomputed/"
VOLUMES = [
    "precomputed_codings_bare",
    "precomputed_compresso",
    "precomputed_crackle",
    "precomputed_float32",
    "precomputed_jpeg_rgb",
    "precomputed_jxl",
    "precomputed_png",
    "precomputed_raw_clipped",
    "precomputed_segmentation",
    "precomputed_segmentation_sharded",
    "precomputed_sharded_jpeg",
    "precomputed_sharded_raw",
]


async def write_array(store, key: str, out: Path) -> None:
    prototype = default_buffer_prototype()
    async for name in store.list_prefix(f"{key}/"):
        if name == f"{key}/zarr.json" or name.startswith(f"{key}/c/"):
            value = await store.get(name, prototype)
            path = out / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value.to_bytes())


def write(name: str) -> None:
    out = HERE / name
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "archive.vzip"
        zarrify_store(str(FIXTURES / name), f"{URL}{name}/").save(str(archive))
        reader = refkv.open(
            str(archive), registry={"https://example.test": LocalStore(FIXTURES.parent)}
        )
        store = zarr_store(reader)
        for key, array in zarr.open_group(store, mode="r").arrays():
            asyncio.run(write_array(store, key, out))
            (out / f"{key}.expected").write_bytes(
                array[...].astype(array.dtype.newbyteorder("<")).tobytes()
            )


for volume in VOLUMES:
    write(volume)
