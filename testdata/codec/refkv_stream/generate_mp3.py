"""Writes the refkv.stream MP3 chunks the refkv_stream_mp3 browser test decodes.

For each of refkv's MP3 fixtures that has ffmpeg's decoding stored
(fixtures/mp3/expected), refkv zarrifies the file twice, with 256 frames a
chunk (one chunk, no lead-in) and with 4 (several chunks, each with its
lead-in), and this writes each array's zarr.json and the chunks' bytes, with
their references resolved, as a directory store; ffmpeg's decoding is copied
beside them.

Usage, from a refkv checkout <https://github.com/d-v-b/refkv>:
  uv run --project <refkv>/python --extra media python generate_mp3.py <refkv>
"""

import shutil
import sys
from pathlib import Path

from refkv import _core
from refkv.ir import zarrify

HERE = Path(__file__).parent / "mp3"
NAMES = [
    "mp3_mpeg1_stereo_cbr",
    "mp3_mpeg1_mono_vbr",
    "mp3_mpeg2_mono_16k",
    "mp3_mpeg2_stereo_crc",
    "mp3_mpeg25_mono_8k",
    "mp3_info_lavc",
]


def write(path: Path, out: Path, chunk_frames: int) -> None:
    data = path.read_bytes()
    _core._set_chunk_frames(chunk_frames)
    try:
        _, result, _ = zarrify(str(path), f"https://data.test/{path.name}")
    finally:
        _core._set_chunk_frames(None)
    (out / "zarr.json").write_bytes(result.bytes_entries["samples/zarr.json"])
    for key, (lit, *ranges) in result.refs.items():
        if not key.startswith("samples/c/"):
            continue
        chunk = out / key.removeprefix("samples/")
        chunk.parent.mkdir(parents=True, exist_ok=True)
        chunk.write_bytes(lit + b"".join(data[o : o + n] for o, n in ranges))


def main(refkv: Path) -> None:
    fixtures = refkv / "fixtures" / "mp3"
    shutil.rmtree(HERE, ignore_errors=True)
    for name in NAMES:
        for chunk_frames in (256, 4):
            out = HERE / name / f"f{chunk_frames}"
            out.mkdir(parents=True)
            write(fixtures / f"{name}.mp3", out, chunk_frames)
        shutil.copy(fixtures / "expected" / f"{name}.npy", HERE / name / "expected.npy")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
