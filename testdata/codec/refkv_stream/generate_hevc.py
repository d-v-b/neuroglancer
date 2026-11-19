"""Writes the refkv.stream HEVC chunks the refkv_stream_hevc browser test decodes.

For each of refkv's HEVC fixtures below (fixtures/mp4 and fixtures/h5j: 4:2:0
of 8, 10 and 12 bits, 4:2:2 of 8 and 12, 4:0:0 of 8, 10 and 12, an odd size,
open GOPs with RASL pictures, RADL pictures, a track of several chunks, and
H5J channels whose array crops the coded pictures), refkv zarrifies the file
with its own chunks and, but for the long track (whose own are two), with 4
frames a chunk (several chunks, each with its lead-in), and this writes each HEVC plane array's zarr.json and its
chunks' bytes, with their references resolved, as a directory store; refkv's
own decoding of the array (ffmpeg's, through PyAV) is beside them, and
index.json lists the stores.

Usage, from a refkv checkout <https://github.com/d-v-b/refkv>:
  uv run --project <refkv>/python --extra media python generate_hevc.py <refkv>
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import refkv.zarr
import zarr
from refkv import _core
from refkv.ir import zarrify

HERE = Path(__file__).parent / "hevc"
NAMES = [
    "mp4/mp4_hevc_aac.mp4",
    "mp4/mp4_hevc_main10.mp4",
    "mp4/mp4_hevc_12bit.mp4",
    "mp4/mp4_hevc_422_8bit.mp4",
    "mp4/mp4_hevc_422_12bit.mp4",
    "mp4/mp4_hevc_gray10_groups.mp4",
    "mp4/mp4_hevc_gray12.mp4",
    "mp4/mp4_hevc_odd_size.mp4",
    "mp4/mp4_hevc_open_gop.mp4",
    "mp4/mp4_hevc_radl.mp4",
    "mp4/mp4_hevc_long.mp4",
    "h5j/h5j_8bit.h5j",
    "h5j/h5j_two_channels.h5j",
]


def hevc_arrays(entries: dict[str, bytes]) -> list[str]:
    """The paths of the arrays of HEVC planes."""
    paths = []
    for key, value in entries.items():
        if not key.endswith("/zarr.json"):
            continue
        meta = json.loads(value)
        if meta.get("node_type") == "array" and any(
            c["name"] == "refkv.stream" and c["configuration"]["format"] == "hevc"
            for c in meta["codecs"]
        ):
            paths.append(key.removesuffix("/zarr.json"))
    return sorted(paths)


def write(path: Path, out: Path, chunk_frames: int | None) -> list[str]:
    data = path.read_bytes()
    _core._set_chunk_frames(chunk_frames)
    try:
        _, result, _ = zarrify(str(path))
    finally:
        _core._set_chunk_frames(None)
    arrays = hevc_arrays(result.bytes_entries)
    for array in arrays:
        store = out / array.replace("/", "_") / f"f{chunk_frames or 0}"
        store.mkdir(parents=True)
        (store / "zarr.json").write_bytes(result.bytes_entries[f"{array}/zarr.json"])
        for key, (lit, *ranges) in result.refs.items():
            if not key.startswith(f"{array}/c/"):
                continue
            chunk = store / key.removeprefix(f"{array}/")
            chunk.parent.mkdir(parents=True, exist_ok=True)
            chunk.write_bytes(lit + b"".join(data[o : o + n] for o, n in ranges))
        if chunk_frames is None:
            root = zarr.open_group(
                refkv.zarr.store(result.to_store()), mode="r", zarr_format=3
            )
            np.save(store.parent / "expected.npy", root.get_array(array)[...])
    return arrays


def main(refkv_dir: Path) -> None:
    shutil.rmtree(HERE, ignore_errors=True)
    index: dict[str, list[str]] = {}
    for name in NAMES:
        out = HERE / Path(name).stem
        for chunk_frames in (None,) if "long" in name else (None, 4):
            for array in write(refkv_dir / "fixtures" / name, out, chunk_frames):
                key = f"{out.name}/{array.replace('/', '_')}"
                index.setdefault(key, []).append(f"f{chunk_frames or 0}")
    (HERE / "index.json").write_text(json.dumps(index, indent=1) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
