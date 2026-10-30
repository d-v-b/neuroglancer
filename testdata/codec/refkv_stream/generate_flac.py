"""Writes the refkv.stream FLAC shards the refkv_stream_flac browser test decodes.

For each of refkv's FLAC fixtures that refkv accepts (fixtures/flac), but
those whose frames another's repeat with other metadata blocks, refkv
zarrifies the file, and this writes the samples array's zarr.json and its
shards' bytes, with their references resolved, as a directory store, and
refkv's own decoding of the array (whose MD5 is STREAMINFO's, as refkv's
python/tests/ir/test_flac.py checks) beside them.

Usage, from a refkv checkout <https://github.com/d-v-b/refkv>:
  uv run --project <refkv>/python --extra media python generate_flac.py <refkv>
"""

import shutil
import sys
from pathlib import Path

import numpy as np
import zarr

import refkv.zarr
from refkv.ir import zarrify

HERE = Path(__file__).parent / "flac"
NAMES = [
    "flac_bitwise_8",
    "flac_bitwise_12_side",
    "flac_bitwise_20_mid",
    "flac_bitwise_32",
    "flac_bitwise_streaminfo_codes",
    "flac_bitwise_uncommon",
    "flac_many_frames",
    "flac_mono_16",
    "flac_mono_24",
    "flac_single_frame",
    "flac_stereo_16_seektable",
    "flac_stereo_24",
]


def write(path: Path, out: Path) -> None:
    data = path.read_bytes()
    _, result, _ = zarrify(str(path))
    (out / "zarr.json").write_bytes(result.bytes_entries["samples/zarr.json"])
    for key, parts in result.refs.items():
        if not key.startswith("samples/c/"):
            continue
        shard = out / key.removeprefix("samples/")
        shard.parent.mkdir(parents=True, exist_ok=True)
        shard.write_bytes(
            b"".join(p if isinstance(p, bytes) else data[p[-2] : p[-2] + p[-1]] for p in parts)
        )
    root = zarr.open_group(refkv.zarr.store(result.to_store()), mode="r", zarr_format=3)
    np.save(out / "expected.npy", root.get_array("samples")[...])


def main(refkv_dir: Path) -> None:
    shutil.rmtree(HERE, ignore_errors=True)
    for name in NAMES:
        out = HERE / name
        out.mkdir(parents=True)
        write(refkv_dir / "fixtures" / "flac" / f"{name}.flac", out)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
